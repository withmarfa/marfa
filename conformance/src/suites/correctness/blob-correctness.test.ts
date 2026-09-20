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

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A link's bytes, fetched with no credential at all. */
async function fetchLink(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/**
 * A refused link: a status outside 2xx, and none of the blob's bytes. The
 * status itself is the signer's own, and the instance and an object store
 * answer a dead link with different ones; a client holding a link must not
 * care which of them signed it.
 */
function expectRefused(
  fetched: Awaited<ReturnType<typeof fetchLink>>,
  content: Uint8Array,
) {
  expect(Math.floor(fetched.status / 100)).not.toBe(2);
  expect(fetched.bytes).not.toEqual(content);
}

describe("blob correctness", () => {
  it("upload returns the sha256 hash, the mime type sent and the byte length", async () => {
    const content = new TextEncoder().encode("hello blob world");

    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.status).toBe(201);
    await expectMatchesSchema("POST", "/blobs", 201, upload.data);
    expect(upload.data.hash).toBe(hashOf(content));
    expect(upload.data.mime_type).toBe("text/plain");
    expect(upload.data.size_bytes).toBe(content.byteLength);
  });

  it("stores a body far larger than the JSON cap, whole", async () => {
    // Sixty-four mebibytes and three bytes: well past the cap the JSON
    // write surface refuses at. The hash proves every byte arrived, the
    // download that they can be read.
    const content = new Uint8Array(64 * 1_048_576 + 3);
    for (let i = 0; i < content.length; i += 4093) content[i] = i & 0xff;

    const upload = await client.uploadBlob(content, "application/octet-stream");
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    expect(upload.data.hash).toBe(hashOf(content));
    expect(upload.data.size_bytes).toBe(content.byteLength);

    const download = await client.downloadBlob(upload.data.hash);
    expect(download.ok).toBe(true);
    expect(download.headers.get("content-length")).toBe(
      String(content.byteLength),
    );
    expect(hashOf(new Uint8Array(download.data))).toBe(upload.data.hash);
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

  it("serves one byte range with 206, and 416 outside the blob", async () => {
    const content = new TextEncoder().encode("0123456789");
    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.ok).toBe(true);

    const ranged = await client.downloadBlob(upload.data.hash, {
      Range: "bytes=2-5",
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    expect(new TextDecoder().decode(ranged.data)).toBe("2345");

    const outside = await client.downloadBlob(upload.data.hash, {
      Range: "bytes=10-12",
    });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("content-range")).toBe("bytes */10");
    expect(outside.error?.error.code).toBe("range_not_satisfiable");
  });

  it("answers HEAD with the headers of the bytes", async () => {
    const content = new TextEncoder().encode("headers only");
    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.ok).toBe(true);

    const head = await client.headBlob(upload.data.hash);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/plain");
    expect(head.headers.get("content-length")).toBe(String(content.length));
    expect(head.headers.get("etag")).toBe(`"${upload.data.hash}"`);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
  });

  it("duplicate upload returns same hash without error", async () => {
    const content = new TextEncoder().encode("duplicate blob test");

    const first = await client.uploadBlob(content, "text/plain");
    expect(first.ok).toBe(true);

    const second = await client.uploadBlob(content, "text/plain");
    expect(second.ok).toBe(true);
    expect(second.data.hash).toBe(first.data.hash);
  });

  it("refuses a multipart body and takes the same bytes raw", async () => {
    const content = new TextEncoder().encode(
      '--b\r\nContent-Disposition: form-data; name="file"\r\n\r\nx\r\n--b--\r\n',
    );
    const refused = await client.uploadBlob(
      content,
      "multipart/form-data; boundary=b",
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");

    const accepted = await client.uploadBlob(content, "text/plain");
    expect(accepted.status).toBe(201);
    expect(accepted.data.hash).toBe(hashOf(content));
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

  it("mints a link that fetches the bytes without a credential", async () => {
    const content = new TextEncoder().encode("bytes behind a link");
    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.ok).toBe(true);

    const link = await client.getBlobUrl(upload.data.hash, 90);
    expect(link.status).toBe(200);
    await expectMatchesSchema("GET", "/blobs/{hash}/url", 200, link.data);
    expect(link.data.expires_in).toBe(90);

    const fetched = await fetchLink(link.data.url);
    expect(fetched.status).toBe(200);
    expect(fetched.bytes).toEqual(content);
    expect(fetched.headers.get("content-type")).toContain("text/plain");

    const ranged = await fetchLink(link.data.url, { Range: "bytes=0-4" });
    expect(ranged.status).toBe(206);
    expect(new TextDecoder().decode(ranged.bytes)).toBe("bytes");
  });

  it("caps a link's lifetime at seven days", async () => {
    const content = new TextEncoder().encode("a week at most");
    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.ok).toBe(true);
    const link = await client.getBlobUrl(upload.data.hash, 10_000_000);
    expect(link.status).toBe(200);
    expect(link.data.expires_in).toBe(7 * 24 * 60 * 60);
  });

  it("refuses a link that has expired or was altered", async () => {
    const content = new TextEncoder().encode("a link that stops working");
    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.ok).toBe(true);

    const link = await client.getBlobUrl(upload.data.hash, 1);
    expect(link.status).toBe(200);
    // The witness: the same link fetches while it lives.
    const live = await fetchLink(link.data.url);
    expect(live.status).toBe(200);
    expect(live.bytes).toEqual(content);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expectRefused(await fetchLink(link.data.url), content);

    const fresh = await client.getBlobUrl(upload.data.hash, 60);
    const altered = new URL(fresh.data.url);
    // The instance signs under `signature`; an object store under SigV4's
    // own name. Whichever it is, one character of it changes.
    const name = altered.searchParams.has("signature")
      ? "signature"
      : "X-Amz-Signature";
    const signature = altered.searchParams.get(name) ?? "";
    expect(signature.length).toBeGreaterThan(0);
    altered.searchParams.set(
      name,
      (signature.startsWith("0") ? "1" : "0") + signature.slice(1),
    );
    expectRefused(await fetchLink(altered.toString()), content);
  });

  it("answers 404 for a link to an unknown hash and 400 for a malformed one", async () => {
    const content = new TextEncoder().encode("a hash the instance knows");
    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.ok).toBe(true);
    expect((await client.getBlobUrl(upload.data.hash)).status).toBe(200);
    const unknown = await client.getBlobUrl(`sha256:${"0".repeat(64)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("blob_not_found");
    const malformed = await client.getBlobUrl("not-a-hash");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
  });

  it("refuses a malformed hash and an empty upload", async () => {
    const one = await client.uploadBlob(new Uint8Array([1]), "text/plain");
    expect(one.status).toBe(201);
    expect((await client.downloadBlob(one.data.hash)).status).toBe(200);
    const malformed = await client.downloadBlob("not-a-hash");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
    const empty = await client.uploadBlob(new Uint8Array(0), "text/plain");
    expect(empty.status).toBe(400);
    expect(empty.error?.error.code).toBe("validation_error");
  });
});
