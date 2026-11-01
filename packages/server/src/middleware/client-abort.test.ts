import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createTestContext, type TestContext } from "../test-utils.js";

let ctx: TestContext;
let receiver: Server;
let alerts = 0;
let server: Server;
let port: number;
let lines: Record<string, unknown>[];
const reported = vi.fn();

beforeAll(async () => {
  receiver = createServer((_req, res) => {
    alerts++;
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  ctx = await createTestContext({
    errorWebhookUrl: `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/alert`,
  });
  server = serve({
    fetch: ctx.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
  globalThis.__marfaReportException = reported;
});

afterAll(async () => {
  globalThis.__marfaReportException = undefined;
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await ctx.cleanup();
  await new Promise<void>((resolve) => {
    receiver.close(() => {
      resolve();
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  reported.mockClear();
  alerts = 0;
});

function watchLog(): void {
  lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    for (const line of String(chunk).split("\n")) {
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Not a JSON log line.
      }
    }
    return true;
  });
}

/** Send an upload that promises `promised` bytes but delivers `sent`, then either ends or drops the connection. */
function upload(sent: number, promised: number, drop: boolean): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `POST /blobs HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAuthorization: Bearer ${ctx.workingKey}\r\n` +
          `Content-Type: application/octet-stream\r\nContent-Length: ${String(promised)}\r\n\r\n`,
      );
      socket.write(Buffer.alloc(sent, 1), () => {
        if (drop) setTimeout(() => socket.resetAndDestroy(), 50);
      });
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      resolve();
    });
    if (!drop) socket.resume();
  });
}

const requestLines = () =>
  lines.filter((line) => line.path === "/blobs" && line.transport === "http");

it("logs an upload the client dropped as aborted, with no 500 and no exception report", async () => {
  watchLog();
  await upload(1000, 100_000, true);
  await vi.waitFor(() => {
    expect(requestLines()).toHaveLength(1);
  });

  const [entry] = requestLines();
  expect(entry).toMatchObject({
    method: "POST",
    route: "/blobs",
    status: 499,
  });
  expect(entry?.duration_ms).toEqual(expect.any(Number));
  expect(lines.filter((line) => line.message === "Unhandled error")).toEqual(
    [],
  );
  expect(reported).not.toHaveBeenCalled();
  expect(alerts).toBe(0);
});

it("still reports a server error on the same route that says it was aborted", async () => {
  // The witness for the test above: a fault is producible on this route and
  // is seen, even when its text matches a client abort, while the client is
  // still there.
  watchLog();
  vi.spyOn(ctx.storage.blobs, "register").mockRejectedValue(
    new Error("aborted"),
  );
  await upload(1000, 1000, false);
  await vi.waitFor(() => {
    expect(requestLines()).toHaveLength(1);
  });

  expect(requestLines()[0]).toMatchObject({ status: 500 });
  expect(
    lines.filter((line) => line.message === "Unhandled error"),
  ).toHaveLength(1);
  expect(reported).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => {
    expect(alerts).toBe(1);
  });
});
