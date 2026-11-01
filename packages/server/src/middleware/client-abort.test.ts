import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  enforceRequestDeadline,
  severAllConnections,
} from "../request-deadline.js";
import { captureLogLines } from "../test-log.js";
import { createTestContext, type TestContext } from "../test-utils.js";

let ctx: TestContext;
let receiver: Server;
let alerts = 0;
let lines: Record<string, unknown>[];
const reported = vi.fn();

interface Listener {
  server: Server;
  port: number;
  sockets: Socket[];
}
const listeners: Listener[] = [];

/**
 * The app on a real listener, with the request deadline of the public listener
 * when `deadlineMs` is given, and with every request held until `gate`
 * settles when it is given, so the connection can end before the app first
 * touches the body.
 */
async function listen(
  deadlineMs?: number,
  gate?: Promise<void>,
): Promise<Listener> {
  const server = serve({
    fetch: gate
      ? async (request, env) => {
          await gate;
          return ctx.app.fetch(request, env);
        }
      : ctx.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  }) as Server;
  if (deadlineMs !== undefined) enforceRequestDeadline(server, deadlineMs);
  const sockets: Socket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const listener = {
    server,
    port: (server.address() as AddressInfo).port,
    sockets,
  };
  listeners.push(listener);
  return listener;
}

let main: Listener;

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
  main = await listen();
  globalThis.__marfaReportException = reported;
});

afterAll(async () => {
  globalThis.__marfaReportException = undefined;
  await Promise.all(
    listeners.map(
      ({ server }) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
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

/** A `POST` to `path` that promises `promised` bytes and sends `sent`, then waits as the caller decides. */
function openUpload(
  at: Listener,
  sent: number,
  promised: number,
  path = "/blobs",
  contentType = "application/octet-stream",
): {
  /** Settles once the server has read everything the client sent. */
  taken: Promise<void>;
  /** Drops the connection with a reset. */
  reset: () => void;
  /** Settles once the connection is closed. */
  closed: Promise<void>;
} {
  const head =
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAuthorization: Bearer ${ctx.workingKey}\r\n` +
    `Content-Type: ${contentType}\r\nContent-Length: ${String(promised)}\r\n\r\n`;
  const total = Buffer.byteLength(head) + sent;
  const socket = connect(at.port, "127.0.0.1", () => {
    socket.write(head);
    socket.write(Buffer.alloc(sent, 1));
  });
  socket.on("error", () => undefined);
  socket.resume();
  return {
    taken: vi.waitFor(() => {
      const mine = at.sockets.find(
        (candidate) => candidate.remotePort === socket.localPort,
      );
      expect(mine?.bytesRead).toBe(total);
    }),
    reset: () => {
      socket.resetAndDestroy();
    },
    closed: new Promise((resolve) => {
      socket.on("close", () => {
        resolve();
      });
    }),
  };
}

const requestLines = (path = "/blobs") =>
  lines.filter((line) => line.path === path && line.transport === "http");

it("logs an upload the client dropped as aborted, with no 500 and no exception report", async () => {
  lines = captureLogLines();
  const upload = openUpload(main, 1000, 100_000);
  await upload.taken;
  upload.reset();
  await upload.closed;
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

it("logs an upload as dropped when the client left before the server first read the body", async () => {
  // A slow runner reaches the body after the connection has ended; Node then
  // hands over a body that is already closed, which reads as empty.
  lines = captureLogLines();
  let open!: () => void;
  const at = await listen(
    undefined,
    new Promise<void>((resolve) => {
      open = resolve;
    }),
  );
  const upload = openUpload(at, 1000, 100_000);
  await upload.taken;
  upload.reset();
  await upload.closed;
  open();
  await vi.waitFor(() => {
    expect(requestLines()).toHaveLength(1);
  });

  expectLoggedAs("/blobs", 499);
});

it("still refuses a complete upload with no bytes as an empty blob", async () => {
  // The witness for the test above: a body that is empty because its sender
  // sent none is the caller's mistake, and stays a 400.
  lines = captureLogLines();
  const upload = openUpload(main, 0, 0);
  await upload.closed;
  await vi.waitFor(() => {
    expect(requestLines()).toHaveLength(1);
  });

  expect(requestLines()[0]).toMatchObject({
    status: 400,
    error_code: "validation_error",
  });
  expect(reported).not.toHaveBeenCalled();
});

it("still reports a server error on the same route that says it was aborted", async () => {
  // The witness for the test above: a fault is producible on this route and
  // is seen, even when its text matches a client abort, while the client is
  // still there.
  lines = captureLogLines();
  vi.spyOn(ctx.storage.blobs, "register").mockRejectedValue(
    new Error("aborted"),
  );
  await openUpload(main, 1000, 1000).closed;
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

/** What the log, the exception reporter and the alert webhook show of a request the server ended itself. */
function expectLoggedAs(path: string, status: number): void {
  expect(requestLines(path)).toHaveLength(1);
  expect(requestLines(path)[0]).toMatchObject({ route: path, status });
  expect(lines.filter((line) => line.message === "Unhandled error")).toEqual(
    [],
  );
  expect(reported).not.toHaveBeenCalled();
  expect(alerts).toBe(0);
}

it("logs a request the request deadline cut off as the 408 the server answered, not as a client drop", async () => {
  lines = captureLogLines();
  const at = await listen(300);
  await openUpload(at, 1000, 100_000, "/items", "application/json").closed;
  await vi.waitFor(() => {
    expect(requestLines("/items")).toHaveLength(1);
  });

  expectLoggedAs("/items", 408);
});

it("logs an upload cut off when the server closes every connection as the 503, not as a client drop", async () => {
  lines = captureLogLines();
  const at = await listen(60_000);
  const upload = openUpload(at, 1000, 100_000);
  await upload.taken;
  severAllConnections(at.server);
  await upload.closed;
  await vi.waitFor(() => {
    expect(requestLines()).toHaveLength(1);
  });

  expectLoggedAs("/blobs", 503);
});
