import { get } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { byteDifference } from "../../utils/bytes.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";
import { clientsFor, DISK_ONLY } from "../../utils/own-blob-server.js";

let server: FreshServer;
let hash: string;
const bytes = Buffer.alloc(8 * 1024 * 1024, 42);

beforeAll(async () => {
  server = await bootFreshServer("blob-read-lifetime", {
    ...DISK_ONLY,
    MARFA_BLOB_READ_IDLE_TIMEOUT_MS: "500",
  });
  const { working } = clientsFor(server);
  const upload = await working.uploadBlob(bytes, "application/octet-stream");
  expect(upload.status).toBe(201);
  hash = upload.data.hash;
  const note = await working.createItem({
    type: "core.note",
    source: "blob-read-lifetime",
    properties: { body: `![bytes](${hash})` },
  });
  expect(note.status).toBe(201);
});

afterAll(async () => {
  await server?.stop();
});

async function healthy(): Promise<void> {
  expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
}

describe("blob download lifetime", () => {
  it("finishes an active download and stays up after a client disconnects", async () => {
    const headers = { Authorization: `Bearer ${server.workingKey}` };
    const complete = await fetch(`${server.apiUrl}/blobs/${hash}`, { headers });
    expect(complete.status).toBe(200);
    expect(
      byteDifference(new Uint8Array(await complete.arrayBuffer()), bytes),
    ).toBeNull();
    await new Promise<void>((resolve, reject) => {
      const request = get(
        `${server.apiUrl}/blobs/${hash}`,
        { headers },
        (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
          response.once("error", reject);
        },
      );
      request.once("error", reject);
    });
    await healthy();
  });

  it("ends a download that stops reading before the body finishes", async () => {
    const received = await new Promise<number>((resolve, reject) => {
      let count = 0;
      const request = get(
        `${server.apiUrl}/blobs/${hash}`,
        {
          headers: { Authorization: `Bearer ${server.workingKey}` },
        },
        (response) => {
          expect(response.statusCode).toBe(200);
          response.pause();
          response.on("data", (chunk: Buffer) => {
            count += chunk.length;
          });
          response.once("aborted", () => resolve(count));
          response.once("end", () =>
            reject(new Error("idle download finished")),
          );
          response.once("error", () => {});
          // Resume only after the server's idle lifetime has elapsed, to
          // observe its socket closure rather than close the client ourselves.
          setTimeout(() => response.resume(), 2_000);
        },
      );
      request.once("error", reject);
    });
    expect(received).toBeLessThan(bytes.length);
    await healthy();
  });
});
