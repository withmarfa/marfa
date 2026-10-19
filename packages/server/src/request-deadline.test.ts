import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { enforceRequestDeadline } from "./request-deadline.js";
import { uploadBody } from "./upload-body.js";
import type { AppEnv } from "./middleware/auth.js";

const DEADLINE_MS = 300;
const IDLE_MS = 400;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

/**
 * A server with the fixed deadline and two doors: `/plain` reads its body as
 * any ordinary door does, and `/upload` reads it through `uploadBody` as a
 * restore does, and answers how many bytes arrived.
 */
async function serve(): Promise<number> {
  const app = new Hono<AppEnv>();
  app.post("/plain", async (c) => c.text(String((await c.req.text()).length)));
  app.post("/upload", async (c) => {
    let received = 0;
    try {
      const body = uploadBody(c, IDLE_MS);
      for await (const chunk of body ?? [])
        received += (chunk as Buffer).length;
    } catch (error) {
      if (
        error instanceof MarfaError &&
        error.code === ErrorCode.REQUEST_TIMEOUT
      )
        return c.text(`stalled after ${String(received)}`, 408);
      throw error;
    }
    return c.text(String(received));
  });
  const listener = getRequestListener(app.fetch);
  const server = createServer((req, res) => {
    void listener(req, res);
  });
  // The deadline check below has no wait of its own, so the headers timeout
  // is checked on a short interval to make its cut-off prompt.
  Object.assign(server, { connectionsCheckingInterval: 25 });
  enforceRequestDeadline(server, DEADLINE_MS);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

interface Outcome {
  status: number | string;
  body: string;
  ms: number;
}

/** Send `pieces` chunks of `size` bytes, `gapMs` apart, then end the body. */
function send(
  port: number,
  path: string,
  pieces: number,
  gapMs: number,
  size = 10,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const settle = (status: number | string, body: string) => {
      clearTimeout(timer);
      resolve({ status, body, ms: performance.now() - started });
    };
    const req = request(
      {
        port,
        host: "127.0.0.1",
        path,
        method: "POST",
        agent: false,
        headers: { "transfer-encoding": "chunked" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          settle(res.statusCode ?? 0, body);
        });
        res.on("error", () => {
          settle("reset", body);
        });
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      settle(error.code ?? "error", "");
    });
    let sent = 0;
    const tick = () => {
      if (req.destroyed) return;
      if (sent >= pieces) {
        req.end();
        return;
      }
      req.write("x".repeat(size));
      sent += 1;
      timer = setTimeout(tick, gapMs);
    };
    tick();
  });
}

describe("the fixed request deadline", () => {
  it("lets a fast request through", async () => {
    const port = await serve();
    expect(await send(port, "/plain", 2, 10)).toMatchObject({
      status: 200,
      body: "20",
    });
  });

  it("cuts a request that has not arrived whole in time, answering 408", async () => {
    const port = await serve();
    const outcome = await send(port, "/plain", 1, 60_000);
    expect(outcome.status).toBe(408);
    expect(outcome.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 30);
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + 600);
  });

  it("cuts a request whose bytes keep arriving, however slowly, once the deadline has passed", async () => {
    const port = await serve();
    const outcome = await send(port, "/plain", 12, 100);
    // A sender still writing when the server closes may see the connection
    // reset before it reads the 408.
    expect([408, "ECONNRESET", "EPIPE"]).toContain(outcome.status);
    expect(outcome.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 30);
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + 600);
  });

  it("does not wait on a client that has sent nothing", async () => {
    const port = await serve();
    const closed = await new Promise<number>((resolve) => {
      const started = performance.now();
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /plain HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n",
        );
      });
      socket.on("close", () => {
        resolve(performance.now() - started);
      });
      socket.on("error", () => undefined);
      socket.resume();
    });
    expect(closed).toBeGreaterThanOrEqual(DEADLINE_MS - 30);
    expect(closed).toBeLessThan(DEADLINE_MS + 600);
  });
});

describe("an upload door", () => {
  it("is not cut off by the fixed deadline while bytes keep arriving", async () => {
    const port = await serve();
    const outcome = await send(port, "/upload", 12, 100);
    expect(outcome).toMatchObject({ status: 200, body: "120" });
    expect(outcome.ms).toBeGreaterThan(DEADLINE_MS * 3);
  });

  it("ends a body that stops arriving after the idle limit, answering 408", async () => {
    const port = await serve();
    const outcome = await send(port, "/upload", 1, 60_000);
    expect(outcome.status).toBe(408);
    expect(outcome.body).toBe("stalled after 10");
    expect(outcome.ms).toBeGreaterThanOrEqual(IDLE_MS - 30);
    expect(outcome.ms).toBeLessThan(IDLE_MS + 700);
  });

  it("ends a body that never starts, after the idle limit", async () => {
    const port = await serve();
    const answer = await new Promise<string>((resolve) => {
      let text = "";
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => (text += chunk.toString()));
      socket.on("close", () => {
        resolve(text);
      });
      socket.on("error", () => undefined);
      socket.resume();
    });
    expect(answer).toContain("408");
    expect(answer).toContain("stalled after 0");
  });

  it("leaves the fixed deadline on the other requests of the same server", async () => {
    const port = await serve();
    const [upload, plain] = await Promise.all([
      send(port, "/upload", 12, 100),
      send(port, "/plain", 1, 60_000),
    ]);
    expect(upload.status).toBe(200);
    expect(plain.status).toBe(408);
  });
});

describe("the headers timeout", () => {
  it("still cuts a request whose headers never finish", async () => {
    const port = await serve();
    const server = servers[0]!;
    server.headersTimeout = 150;
    const closed = await new Promise<number>((resolve) => {
      const started = performance.now();
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("POST /upload HTTP/1.1\r\nHost: x\r\n");
      });
      socket.on("close", () => {
        resolve(performance.now() - started);
      });
      socket.on("error", () => undefined);
      socket.resume();
    });
    expect(closed).toBeLessThan(2_000);
  });
});
