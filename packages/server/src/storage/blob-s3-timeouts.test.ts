import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3BlobStore, s3Timeouts } from "./blob-s3.js";

/**
 * The real SDK against a bucket that accepts every connection and never
 * answers, which is what a hung object store looks like from here.
 */
let silent: Server;
let endpoint: string;
const sockets = new Set<Socket>();
const saved = { ...s3Timeouts };

beforeAll(async () => {
  silent = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    silent.listen(0, "127.0.0.1", resolve);
  });
  const address = silent.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  endpoint = `http://127.0.0.1:${String(address.port)}`;
  s3Timeouts.requestTimeoutMs = 300;
  s3Timeouts.bodilessRequestTimeoutMs = 300;
});

afterAll(async () => {
  Object.assign(s3Timeouts, saved);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => silent.close(resolve));
});

const store = () =>
  new S3BlobStore({
    bucket: "silent",
    region: "us-east-1",
    endpoint,
    accessKeyId: "test",
    secretAccessKey: "test",
  });

describe("an object store that never answers", () => {
  it("ends a delete with a timeout rather than waiting for good", async () => {
    await expect(store().delete("sha256:abc")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  }, 15_000);

  it("ends a question of presence with a timeout", async () => {
    await expect(store().has("sha256:abc")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  }, 15_000);
});
