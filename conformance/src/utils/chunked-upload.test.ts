import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { chunkedUpload } from "./chunked-upload.js";

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
});

async function listen(): Promise<string> {
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${String(address.port)}`;
}

it("returns an early refusal while the body sender is still waiting", async () => {
  server = createServer((request, response) => {
    request.once("data", () => {
      request.pause();
      response.writeHead(507, { "Content-Type": "application/json" });
      response.end('{"error":"insufficient_storage"}');
    });
  });
  const url = await listen();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const upload = chunkedUpload(url, "test-key", async (write) => {
    await write(new Uint8Array(1024));
    // A sender blocked by backpressure must not hide a complete response.
    await held;
  });
  try {
    const answer = await Promise.race([
      upload,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still waiting for the sender"), 1000);
      }),
    ]);
    expect(answer).toEqual({
      status: 507,
      body: '{"error":"insufficient_storage"}',
    });
  } finally {
    clearTimeout(timer);
    release();
    await upload;
  }
});

it("fails with progress details and closes a request that never gets a response", async () => {
  let onClose!: () => void;
  const closed = new Promise<void>((resolve) => (onClose = resolve));
  server = createServer((request) => {
    request.resume();
    request.socket.once("close", onClose);
  });
  await expect(
    chunkedUpload(
      await listen(),
      "test-key",
      async (write) => {
        await write(new Uint8Array(1024));
      },
      500,
    ),
  ).rejects.toThrow(
    "Chunked upload stalled while waiting for the response after 500ms " +
      "(1024 bytes queued, 1024 flushed, response status not received)",
  );
  await closed;
});

it("returns a refusal while request writes are backpressured", async () => {
  server = createServer((request, response) => {
    request.once("data", () => {
      request.pause();
      response.writeHead(507, { "Content-Length": "7" });
      response.end("refused");
    });
  });
  const answer = await chunkedUpload(
    await listen(),
    "test-key",
    async (write) => {
      for (let part = 0; part < 64; part++) {
        await write(new Uint8Array(512 * 1024));
      }
    },
    2000,
  );
  expect(answer).toEqual({ status: 507, body: "refused" });
});

it("rejects a truncated response instead of reporting a complete refusal", async () => {
  server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(507, { "Content-Length": "100" });
      response.write("partial", () => response.destroy());
    });
  });
  await expect(
    chunkedUpload(await listen(), "test-key", async (write) => {
      await write(new Uint8Array(1024));
    }),
  ).rejects.toThrow();
});
