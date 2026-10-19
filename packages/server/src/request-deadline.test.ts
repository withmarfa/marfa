import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { Hono } from "hono";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
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
async function serve(deadlineMs = DEADLINE_MS): Promise<{
  port: number;
  seen: WeakRef<object>[];
}> {
  const seen: WeakRef<object>[] = [];
  const app = new Hono<AppEnv>();
  app.post("/refuse", (c) => c.text("refused", 401));
  app.get("/ok", (c) => c.text("ok"));
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
  server.on("request", (req) => {
    seen.push(new WeakRef(req));
  });
  enforceRequestDeadline(server, deadlineMs);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen };
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
    const { port } = await serve();
    expect(await send(port, "/plain", 2, 10)).toMatchObject({
      status: 200,
      body: "20",
    });
  });

  it("cuts a request that has not arrived whole in time, answering 408", async () => {
    const { port } = await serve();
    const outcome = await send(port, "/plain", 1, 60_000);
    expect(outcome.status).toBe(408);
    expect(outcome.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 30);
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + 600);
  });

  it("cuts a request whose bytes keep arriving, however slowly, once the deadline has passed", async () => {
    const { port } = await serve();
    const outcome = await send(port, "/plain", 12, 100);
    // A sender still writing when the server closes may see the connection
    // reset before it reads the 408.
    expect([408, "ECONNRESET", "EPIPE"]).toContain(outcome.status);
    expect(outcome.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 30);
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + 600);
  });

  it("does not wait on a client that has sent nothing", async () => {
    const { port } = await serve();
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
    const { port } = await serve();
    const outcome = await send(port, "/upload", 12, 100);
    expect(outcome).toMatchObject({ status: 200, body: "120" });
    expect(outcome.ms).toBeGreaterThan(DEADLINE_MS * 3);
  });

  it("ends a body that stops arriving after the idle limit, answering 408", async () => {
    const { port } = await serve();
    const outcome = await send(port, "/upload", 1, 60_000);
    expect(outcome.status).toBe(408);
    expect(outcome.body).toBe("stalled after 10");
    expect(outcome.ms).toBeGreaterThanOrEqual(IDLE_MS - 30);
    expect(outcome.ms).toBeLessThan(IDLE_MS + 700);
  });

  it("ends a body that never starts, after the idle limit", async () => {
    const { port } = await serve();
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
    const { port } = await serve();
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
    const { port } = await serve();
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

describe("a request answered before its body is whole", () => {
  it("is released when its connection closes, not when the deadline would have passed", async () => {
    // The deadline is far longer than the wait below, so a timer that holds
    // the request until it fires leaves every request alive.
    const { port, seen } = await serve(60_000);
    const count = 40;
    await Promise.all(
      Array.from(
        { length: count },
        () =>
          new Promise<void>((resolve) => {
            const socket = connect(port, "127.0.0.1", () => {
              socket.write(
                "POST /refuse HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\npart",
              );
            });
            socket.on("data", () => {
              // The 401 is in, with most of the body still to come.
              socket.destroy();
            });
            socket.on("close", () => {
              resolve();
            });
            socket.on("error", () => undefined);
          }),
      ),
    );
    expect(seen).toHaveLength(count);
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    const started = performance.now();
    let alive = count;
    while (alive > 0 && performance.now() - started < 3_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      collect();
      alive = seen.filter((ref) => ref.deref() !== undefined).length;
    }
    expect(alive).toBe(0);
  });

  it("still ends a client that keeps sending after the refusal", async () => {
    const { port } = await serve();
    const closed = await new Promise<number>((resolve) => {
      const started = performance.now();
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /refuse HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n",
        );
      });
      const trickle = setInterval(() => {
        socket.write("x", () => undefined);
      }, 50);
      socket.on("close", () => {
        clearInterval(trickle);
        resolve(performance.now() - started);
      });
      socket.on("error", () => undefined);
      socket.resume();
    });
    expect(closed).toBeLessThan(DEADLINE_MS + 1_000);
  });
});

describe("one connection carrying several requests", () => {
  it("serves requests one after another on a kept-alive connection", async () => {
    const { port } = await serve();
    const answers = await new Promise<string>((resolve) => {
      let text = "";
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("GET /ok HTTP/1.1\r\nHost: x\r\n\r\n");
      });
      let sentSecond = false;
      socket.on("data", (chunk) => {
        text += chunk.toString();
        if (!sentSecond) {
          sentSecond = true;
          setTimeout(() => {
            socket.write(
              "GET /ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
            );
          }, DEADLINE_MS + 100);
        }
      });
      socket.on("close", () => {
        resolve(text);
      });
      socket.on("error", () => undefined);
    });
    expect(answers.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
  });

  it("answers requests pipelined in one write", async () => {
    const { port } = await serve();
    const answers = await new Promise<string>((resolve) => {
      let text = "";
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /ok HTTP/1.1\r\nHost: x\r\n\r\nGET /ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => (text += chunk.toString()));
      socket.on("close", () => {
        resolve(text);
      });
      socket.on("error", () => undefined);
    });
    expect(answers.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
  });
});
