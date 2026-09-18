import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "blob-correctness",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("blob correctness", () => {
  it("upload returns the sha256 hash, the mime type sent and the byte length", async () => {
    const content = new TextEncoder().encode("hello blob world");
    const expectedHex = createHash("sha256").update(content).digest("hex");

    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.status).toBe(201);
    await expectMatchesSchema("POST", "/blobs", 201, upload.data);
    expect(upload.data.hash).toBe(`sha256:${expectedHex}`);
    expect(upload.data.mime_type).toBe("text/plain");
    expect(upload.data.size).toBe(content.byteLength);
  });

  it("download returns byte-for-byte identical content", async () => {
    const content = new TextEncoder().encode("roundtrip blob content");

    const upload = await client.uploadBlob(content, "application/octet-stream");
    expect(upload.ok).toBe(true);

    const download = await client.downloadBlob(upload.data.hash);
    expect(download.ok).toBe(true);
    expect(new Uint8Array(download.data)).toEqual(content);
  });

  it("content-type is preserved on download", async () => {
    const content = new TextEncoder().encode("fake png data");

    const upload = await client.uploadBlob(content, "image/png");
    expect(upload.ok).toBe(true);

    const download = await client.downloadBlob(upload.data.hash);
    expect(download.ok).toBe(true);

    const contentType = download.headers.get("content-type");
    expect(contentType).toContain("image/png");
  });

  it("duplicate upload returns same hash without error", async () => {
    const content = new TextEncoder().encode("duplicate blob test");

    const first = await client.uploadBlob(content, "text/plain");
    expect(first.ok).toBe(true);

    const second = await client.uploadBlob(content, "text/plain");
    expect(second.ok).toBe(true);
    expect(second.data.hash).toBe(first.data.hash);
  });

  it("download with an unknown hash returns 404", async () => {
    const fakeHash = "sha256:" + "a".repeat(64);
    const download = await client.downloadBlob(fakeHash);
    expect(download.status).toBe(404);
    expect(download.error?.error.code).toBe("blob_not_found");
  });

  it("blob_ref in properties persists after upload", async () => {
    const content = new TextEncoder().encode("blob for item ref");
    const upload = await client.uploadBlob(content, "application/octet-stream");
    expect(upload.ok).toBe(true);

    const note = createNote({
      source: ctx.source,
      properties: {
        title: "Note with blob",
        body: "Has a blob reference",
        blob_ref: upload.data.hash,
      },
    });
    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);

    const fetched = await client.getItem(created.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.properties.blob_ref).toBe(upload.data.hash);
  });

  it("answers 400 for a presigned URL on the filesystem backend", async () => {
    // The filesystem backend mints no presigned URLs. The same message for a
    // known, an unknown and a malformed hash is what shows the backend check
    // runs before the hash is read; the status alone would not.
    const upload = await client.uploadBlob(
      new TextEncoder().encode("url probe"),
      "text/plain",
    );
    expect(upload.ok).toBe(true);
    const backendMessage =
      "Presigned URLs are not available with the current blob backend";
    for (const hash of [
      upload.data.hash,
      `sha256:${"0".repeat(64)}`,
      "not-a-hash",
    ]) {
      const r = await client.getBlobUrl(hash);
      expect(r.status, hash).toBe(400);
      expect(r.error?.error.code, hash).toBe("validation_error");
      expect(r.error?.error.message, hash).toBe(backendMessage);
    }
  });

  it("refuses a malformed hash and an empty upload", async () => {
    const malformed = await client.downloadBlob("not-a-hash");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
    const empty = await client.uploadBlob(new Uint8Array(0), "text/plain");
    expect(empty.status).toBe(400);
    expect(empty.error?.error.code).toBe("validation_error");
  });
});
