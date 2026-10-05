import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { Readable } from "node:stream";
import { createTestContext, request, withSecondStore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BlobOrphanReporter } from "../housekeeping/blob-orphans.js";
import type { BlobStore } from "../storage/blob-store.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function upload(
  bytes: Uint8Array,
  mimeType = "application/octet-stream",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await ctx.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": mimeType,
    },
    body: bytes,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/**
 * An upload an item names, so the working key may read it back: a blob
 * borrows its reach from the items that reference it.
 */
async function uploadReferenced(
  bytes: Uint8Array,
  mimeType = "application/octet-stream",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const uploaded = await upload(bytes, mimeType);
  const named = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.file",
      properties: { blob_ref: hashOf(bytes), mime_type: mimeType },
    },
  });
  expect(named.status).toBe(201);
  return uploaded;
}

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("POST /blobs", () => {
  it("streams the body to disk and answers the hash, the type and the size", async () => {
    const data = new TextEncoder().encode("Hello, blob world!");
    const { status, body } = await upload(data);
    expect(status).toBe(201);
    expect(body.hash).toBe(hashOf(data));
    expect(body.mime_type).toBe("application/octet-stream");
    expect(body.size_bytes).toBe(data.length);
    expect(await ctx.blobs.disk.has(hashOf(data))).toEqual({
      size_bytes: data.length,
    });
  });

  it("records the disk store as the blob's location", async () => {
    const data = new TextEncoder().encode("located on disk");
    await upload(data);
    const locations = await ctx.storage.blobs.listLocations(hashOf(data));
    expect(locations).toHaveLength(1);
    expect(locations[0]?.store_id).toBe(ctx.blobs.disk.id);
    expect(locations[0]?.kind).toBe("disk");
    expect(locations[0]?.detached).toBe(false);
  });

  it("has no size cap: a body far over the JSON cap is stored whole", async () => {
    // Sixty-four times the JSON body cap. Its hash is computed while the
    // bytes spool, so the answer is the real hash of everything sent.
    const data = new Uint8Array(64 * 1_048_576 + 3);
    for (let i = 0; i < data.length; i += 4096) data[i] = i & 0xff;
    const { status, body } = await upload(data);
    expect(status).toBe(201);
    expect(body.hash).toBe(hashOf(data));
    expect(body.size_bytes).toBe(data.length);
    expect(await ctx.blobs.disk.has(hashOf(data))).toEqual({
      size_bytes: data.length,
    });
  });

  it("deduplicates identical content", async () => {
    const data = new TextEncoder().encode("duplicate content test");
    const first = await upload(data, "text/plain");
    const second = await upload(data, "text/plain");
    expect(first.body.hash).toBe(second.body.hash);
    expect(second.status).toBe(201);
  });

  it("answers a second upload under another type with the type the first recorded", async () => {
    const data = new TextEncoder().encode("typed once, sent twice");
    const first = await upload(data, "text/plain");
    expect(first.body.mime_type).toBe("text/plain");
    const second = await upload(data, "text/html");
    expect(second.status).toBe(201);
    expect(second.body.mime_type).toBe("text/plain");
    const head = await request(ctx.app, "HEAD", `/blobs/${hashOf(data)}`, {
      key: ctx.operatorKey,
    });
    expect(head.headers.get("Content-Type")).toBe("text/plain");
  });

  it("leaves no spool behind, whether the bytes were new or already held", async () => {
    // The witness is the spool the store hands each upload, seen minted
    // under the spool directory and gone once the request has answered.
    const minted = vi.spyOn(ctx.blobs.disk, "spoolPath");
    const data = new TextEncoder().encode("spooled twice");
    expect((await upload(data)).status).toBe(201);
    expect((await upload(data)).status).toBe(201);
    const spools = minted.mock.results.map((r) => r.value as string);
    minted.mockRestore();
    expect(spools).toHaveLength(2);
    for (const spool of spools) {
      expect(dirname(spool)).toBe(ctx.blobs.disk.spoolDir);
    }
    expect(await readdir(ctx.blobs.disk.spoolDir)).toEqual([]);
  });

  it("rejects an empty body, where one byte is enough", async () => {
    const { status, body } = await upload(new Uint8Array(0));
    expect(status).toBe(400);
    expect((body.error as { code: string }).code).toBe("validation_error");
    const one = await upload(new Uint8Array([7]));
    expect(one.status).toBe(201);
    expect(one.body.size_bytes).toBe(1);
  });

  it("refuses a multipart body, which the raw form does not", async () => {
    const data = new TextEncoder().encode(
      "--boundary\r\nnot a form the server reads\r\n",
    );
    const refused = await upload(
      data,
      "multipart/form-data; boundary=boundary",
    );
    expect(refused.status).toBe(400);
    expect((refused.body.error as { code: string }).code).toBe(
      "validation_error",
    );
    const accepted = await upload(data, "text/plain");
    expect(accepted.status).toBe(201);
  });

  it("takes its own bytes back when the registration is refused", async () => {
    const data = new TextEncoder().encode("bytes nothing will name");
    const registry = ctx.storage.blobs;
    const original = registry.recordLocation.bind(registry);
    registry.recordLocation = () =>
      Promise.reject(new Error("the row could not be written"));
    try {
      const refused = await upload(data);
      expect(refused.status).toBe(500);
    } finally {
      registry.recordLocation = original;
    }
    // The file this request wrote is gone: a file no row names would be
    // unreachable and nothing would sweep it.
    expect(await ctx.blobs.disk.has(hashOf(data))).toBeNull();
    expect(await registry.get(hashOf(data))).toBeNull();
    // The witness: the same bytes land once the registry answers.
    const accepted = await upload(data);
    expect(accepted.status).toBe(201);
    expect(await ctx.blobs.disk.has(hashOf(data))).not.toBeNull();
  });

  it("leaves bytes another upload placed when its own registration is refused", async () => {
    const data = new TextEncoder().encode("bytes an earlier upload placed");
    expect((await upload(data)).status).toBe(201);
    const storage = ctx.storage;
    const original = storage.runInTransaction.bind(storage);
    storage.runInTransaction = () =>
      Promise.reject(new Error("the row could not be written"));
    try {
      const refused = await upload(data);
      expect(refused.status).toBe(500);
    } finally {
      storage.runInTransaction = original;
    }
    // Not this request's bytes to take back: the first upload's copy stays.
    expect(await ctx.blobs.disk.has(hashOf(data))).toEqual({
      size_bytes: data.length,
    });
  });

  it("requires authentication", async () => {
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new TextEncoder().encode("no auth"),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /blobs/:hash", () => {
  it("streams a previously uploaded blob with its type and length", async () => {
    const original = new TextEncoder().encode("round-trip test data");
    await uploadReferenced(original, "text/plain");

    const res = await request(ctx.app, "GET", `/blobs/${hashOf(original)}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Length")).toBe(String(original.length));
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("ETag")).toBe(`"${hashOf(original)}"`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(original);
  });

  it("honors one byte range", async () => {
    const original = new TextEncoder().encode("0123456789");
    await uploadReferenced(original, "text/plain");
    const res = await ctx.app.request(`/blobs/${hashOf(original)}`, {
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        Range: "bytes=2-5",
      },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  it("serves an open-ended range to the last byte", async () => {
    const original = new TextEncoder().encode("0123456789");
    await uploadReferenced(original, "text/plain");
    const res = await ctx.app.request(`/blobs/${hashOf(original)}`, {
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        Range: "bytes=7-",
      },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await res.text()).toBe("789");
  });

  it("answers 416 with the size for a range outside the blob", async () => {
    const original = new TextEncoder().encode("0123456789");
    await uploadReferenced(original, "text/plain");
    // The witness: the last byte alone is a range the blob can satisfy.
    const inside = await ctx.app.request(`/blobs/${hashOf(original)}`, {
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        Range: "bytes=9-12",
      },
    });
    expect(inside.status).toBe(206);
    expect(await inside.text()).toBe("9");
    const res = await ctx.app.request(`/blobs/${hashOf(original)}`, {
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        Range: "bytes=10-12",
      },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
    expect(res.headers.get("X-Error-Code")).toBe("range_not_satisfiable");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("range_not_satisfiable");
  });

  it("serves the whole blob when the range is not one it reads", async () => {
    const original = new TextEncoder().encode("0123456789");
    await uploadReferenced(original, "text/plain");
    const res = await ctx.app.request(`/blobs/${hashOf(original)}`, {
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        Range: "bytes=-3",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("returns 404 for unknown hash", async () => {
    const fakeHash = `sha256:${"0".repeat(64)}`;
    const res = await request(ctx.app, "GET", `/blobs/${fakeHash}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the registry names a blob no store holds", async () => {
    const data = new TextEncoder().encode("bytes that will vanish");
    expect((await uploadReferenced(data)).status).toBe(201);
    const before = await request(ctx.app, "GET", `/blobs/${hashOf(data)}`, {
      key: ctx.workingKey,
    });
    expect(before.status).toBe(200);
    await ctx.blobs.disk.delete(hashOf(data));
    const res = await request(ctx.app, "GET", `/blobs/${hashOf(data)}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_not_found");
  });
});

describe("HEAD /blobs/:hash", () => {
  it("answers the headers without a body, from the registry alone", async () => {
    const data = new TextEncoder().encode("head check data");
    await uploadReferenced(data, "text/plain");

    // The bytes are gone from disk and the registry still answers: a HEAD
    // never opens a file, which is what keeps it from holding one open.
    await ctx.blobs.disk.delete(hashOf(data));
    const headRes = await request(ctx.app, "HEAD", `/blobs/${hashOf(data)}`, {
      key: ctx.workingKey,
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("Content-Type")).toBe("text/plain");
    expect(headRes.headers.get("Content-Length")).toBe(String(data.length));
    expect(headRes.headers.get("ETag")).toBe(`"${hashOf(data)}"`);
    expect(await headRes.text()).toBe("");
  });

  it("answers a range's headers with 206", async () => {
    const data = new TextEncoder().encode("0123456789");
    await uploadReferenced(data, "text/plain");
    const res = await ctx.app.request(`/blobs/${hashOf(data)}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        Range: "bytes=2-5",
      },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.headers.get("Content-Length")).toBe("4");
  });

  it("returns 404 for unknown hash", async () => {
    const fakeHash = `sha256:${"0".repeat(64)}`;
    const headRes = await request(ctx.app, "HEAD", `/blobs/${fakeHash}`, {
      key: ctx.workingKey,
    });
    expect(headRes.status).toBe(404);
  });

  it("returns 400 for invalid hash format", async () => {
    const headRes = await request(ctx.app, "HEAD", "/blobs/sha256:invalid", {
      key: ctx.workingKey,
    });
    expect(headRes.status).toBe(400);
  });

  it("requires authentication", async () => {
    const fakeHash = `sha256:${"0".repeat(64)}`;
    const headRes = await ctx.app.request(`/blobs/${fakeHash}`, {
      method: "HEAD",
    });
    expect(headRes.status).toBe(401);
  });
});

describe("GET /blobs/:hash/url", () => {
  it("mints an instance-served link that fetches the bytes without a credential", async () => {
    const data = new TextEncoder().encode("linked bytes");
    await uploadReferenced(data, "text/plain");
    const res = await request(ctx.app, "GET", `/blobs/${hashOf(data)}/url`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expires_in: number };
    expect(body.expires_in).toBe(3600);
    const url = new URL(body.url);
    expect(url.pathname).toBe(`/blobs/${hashOf(data)}/fetch`);
    expect(url.searchParams.get("expires")).toMatch(/^\d+$/);
    expect(url.searchParams.get("signature")).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await ctx.app.request(url.pathname + url.search);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("Content-Type")).toBe("text/plain");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(data);
  });

  it("hands a store that signs its own links the type the blob is served with", async () => {
    const data = new TextEncoder().encode("signed by the store");
    await uploadReferenced(data, "text/html");
    const link = vi.fn((hash: string, ttl: number, mimeType: string) =>
      Promise.resolve(
        `https://store.example/${hash}?${String(ttl)}${mimeType}`,
      ),
    );
    const listed = vi
      .spyOn(ctx.storage.blobs, "listLocations")
      .mockResolvedValueOnce([
        {
          store_id: "signer",
          kind: "s3",
          policy: "all",
          detached: false,
          recorded_at: new Date().toISOString(),
          verified_at: null,
        },
      ]);
    // Only `link` is asked of a store the link door finds holding a copy.
    const signer = { link } as Partial<BlobStore> as BlobStore;
    const byId = vi.spyOn(ctx.blobs, "byId").mockReturnValueOnce(signer);
    try {
      const res = await request(
        ctx.app,
        "GET",
        `/blobs/${hashOf(data)}/url?ttl=60`,
        { key: ctx.workingKey },
      );
      expect(res.status).toBe(200);
      expect(link).toHaveBeenCalledWith(hashOf(data), 60, "text/html");
    } finally {
      listed.mockRestore();
      byId.mockRestore();
    }
  });

  it("names the instance's base URL, not the origin the request arrived on", async () => {
    const data = new TextEncoder().encode("host of the link");
    await uploadReferenced(data, "text/plain");
    // The request's own origin is the socket's, which behind an edge that
    // terminates TLS is `http` on some internal name; the link carries the
    // origin the instance is reached at.
    const res = await ctx.app.request(
      `http://internal.example:8600/blobs/${hashOf(data)}/url`,
      { headers: { Authorization: `Bearer ${ctx.workingKey}` } },
    );
    const body = (await res.json()) as { url: string };
    expect(new URL(body.url).origin).toBe("http://localhost:0");
  });

  it("honors ttl and caps it at seven days", async () => {
    const data = new TextEncoder().encode("ttl bytes");
    await uploadReferenced(data, "text/plain");
    const short = await request(
      ctx.app,
      "GET",
      `/blobs/${hashOf(data)}/url?ttl=60`,
      { key: ctx.workingKey },
    );
    expect(((await short.json()) as { expires_in: number }).expires_in).toBe(
      60,
    );
    const long = await request(
      ctx.app,
      "GET",
      `/blobs/${hashOf(data)}/url?ttl=99999999`,
      { key: ctx.workingKey },
    );
    expect(((await long.json()) as { expires_in: number }).expires_in).toBe(
      7 * 24 * 60 * 60,
    );
  });

  it("refuses an unknown or malformed hash", async () => {
    const data = new TextEncoder().encode("a hash the instance knows");
    await uploadReferenced(data, "text/plain");
    const known = await request(ctx.app, "GET", `/blobs/${hashOf(data)}/url`, {
      key: ctx.workingKey,
    });
    expect(known.status).toBe(200);
    const unknown = await request(
      ctx.app,
      "GET",
      `/blobs/sha256:${"0".repeat(64)}/url`,
      { key: ctx.workingKey },
    );
    expect(unknown.status).toBe(404);
    const malformed = await request(ctx.app, "GET", "/blobs/not-a-hash/url", {
      key: ctx.workingKey,
    });
    expect(malformed.status).toBe(400);
  });
});

describe("GET /blobs/:hash/fetch", () => {
  /** A live link to freshly uploaded bytes, fetched once as it is: the
   *  witness every refusal below alters something to earn. */
  async function link(data: Uint8Array): Promise<URL> {
    await uploadReferenced(data, "text/plain");
    const res = await request(ctx.app, "GET", `/blobs/${hashOf(data)}/url`, {
      key: ctx.workingKey,
    });
    const url = new URL(((await res.json()) as { url: string }).url);
    const live = await ctx.app.request(url.pathname + url.search);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(data);
    return url;
  }

  it("refuses a link whose signature was altered", async () => {
    const url = await link(new TextEncoder().encode("tampered link"));
    const signature = url.searchParams.get("signature") ?? "";
    url.searchParams.set(
      "signature",
      (signature.startsWith("0") ? "1" : "0") + signature.slice(1),
    );
    const res = await ctx.app.request(url.pathname + url.search);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("refuses a link re-pointed at another blob", async () => {
    const url = await link(
      new TextEncoder().encode("the blob the link is for"),
    );
    const other = new TextEncoder().encode("a blob it is not for");
    await uploadReferenced(other, "text/plain");
    const res = await ctx.app.request(
      `/blobs/${hashOf(other)}/fetch${url.search}`,
    );
    expect(res.status).toBe(401);
  });

  it("refuses a link whose expiry was moved", async () => {
    const url = await link(new TextEncoder().encode("extended link"));
    const expires = Number(url.searchParams.get("expires"));
    url.searchParams.set("expires", String(expires + 1));
    const res = await ctx.app.request(url.pathname + url.search);
    expect(res.status).toBe(401);
  });

  it("serves a link its whole lifetime, however late in a second it was minted, and refuses it once expired", async () => {
    const data = new TextEncoder().encode("expiring link");
    await uploadReferenced(data, "text/plain");
    // The last millisecond of a second, where a link counted from the
    // second rounded down would have no life left at all.
    const minted = Math.floor(Date.now() / 1000) * 1000 + 999;
    vi.useFakeTimers({ toFake: ["Date"], now: minted });
    try {
      const res = await request(
        ctx.app,
        "GET",
        `/blobs/${hashOf(data)}/url?ttl=1`,
        { key: ctx.workingKey },
      );
      const url = new URL(((await res.json()) as { url: string }).url);
      vi.setSystemTime(minted + 999);
      const live = await ctx.app.request(url.pathname + url.search);
      expect(live.status).toBe(200);
      expect(new Uint8Array(await live.arrayBuffer())).toEqual(data);
      vi.setSystemTime(minted + 1001);
      const fetched = await ctx.app.request(url.pathname + url.search);
      expect(fetched.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves a range and a HEAD through the link", async () => {
    const url = await link(new TextEncoder().encode("0123456789"));
    const ranged = await ctx.app.request(url.pathname + url.search, {
      headers: { Range: "bytes=0-3" },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("0123");
    const head = await ctx.app.request(url.pathname + url.search, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("10");
  });
});

describe("GET /blobs/stores", () => {
  it("lists the attached disk store to the operator key", async () => {
    const res = await request(ctx.app, "GET", "/blobs/stores", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        kind: string;
        locator: string;
        policy: string;
        detached_at: string | null;
      }[];
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: ctx.blobs.disk.id,
      kind: "disk",
      locator: ctx.blobs.disk.locator,
      policy: "all",
      detached_at: null,
    });
    // The marker in the folder is where the id came from.
    const files = await readdir(ctx.blobs.disk.locator);
    expect(files).toContain(".marfa-store");
    // The minimum a drop is held to, the instance default here.
    expect(body).toHaveProperty("min_copies", 1);
  });

  it("reports the configured minimum copies", async () => {
    const two = await createTestContext({ blobMinCopies: 2 });
    try {
      const res = await request(two.app, "GET", "/blobs/stores", {
        key: two.operatorKey,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ min_copies: 2 });
    } finally {
      await two.cleanup();
    }
  });

  it("refuses a working key where the operator key is answered", async () => {
    const operator = await request(ctx.app, "GET", "/blobs/stores", {
      key: ctx.operatorKey,
    });
    expect(operator.status).toBe(200);
    const res = await request(ctx.app, "GET", "/blobs/stores", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});

describe("GET /blobs/:hash/locations", () => {
  it("lists the log for a blob and 404s for one not registered", async () => {
    const data = new TextEncoder().encode("locations listed");
    await uploadReferenced(data);
    const res = await request(
      ctx.app,
      "GET",
      `/blobs/${hashOf(data)}/locations`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        store_id: string;
        kind: string;
        detached: boolean;
        verified_at: string | null;
      }[];
    };
    expect(body.data).toEqual([
      expect.objectContaining({
        store_id: ctx.blobs.disk.id,
        kind: "disk",
        detached: false,
        verified_at: null,
      }),
    ]);

    const missing = await request(
      ctx.app,
      "GET",
      `/blobs/sha256:${"0".repeat(64)}/locations`,
      { key: ctx.workingKey },
    );
    expect(missing.status).toBe(404);
  });
});

describe("POST /blobs wakes replication", () => {
  it("makes blob-replicate due at once", async () => {
    const woken = await createTestContext();
    try {
      let runs = 0;
      woken.housekeeping.register({
        name: "blob-replicate",
        intervalMs: 3_600_000,
        firstRunDelayMs: 3_600_000,
        run: () => {
          runs += 1;
          return Promise.resolve(null);
        },
      });
      await woken.housekeeping.start();
      // Not due for an hour: a poll runs nothing.
      await woken.housekeeping.poll();
      await woken.housekeeping.settle();
      expect(runs).toBe(0);
      const res = await woken.app.request("/blobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${woken.workingKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: new TextEncoder().encode("wakes the copier"),
      });
      expect(res.status).toBe(201);
      await woken.housekeeping.poll();
      await woken.housekeeping.settle();
      expect(runs).toBe(1);
      await woken.housekeeping.stop();
    } finally {
      await woken.cleanup();
    }
  });
});

describe("GET /blobs/orphans", () => {
  it("answers the report to the operator key and refuses a working key", async () => {
    const data = new TextEncoder().encode("reported, not yet purged");
    await upload(data);
    const reporter = new BlobOrphanReporter(ctx.storage, ctx.blobs, 3_600_000);
    await reporter.runOnce();
    const res = await request(ctx.app, "GET", "/blobs/orphans", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { hash: string; mime_type: string; size_bytes: number }[];
    };
    expect(body.data.map((row) => row.hash)).toContain(hashOf(data));
    expect(body.data.find((row) => row.hash === hashOf(data))).toMatchObject({
      mime_type: "application/octet-stream",
      size_bytes: data.length,
    });
    const working = await request(ctx.app, "GET", "/blobs/orphans", {
      key: ctx.workingKey,
    });
    expect(working.status).toBe(403);
  });
});

describe("DELETE /blobs/:hash/locations/:store", () => {
  it("drops a copy while the minimum holds, refuses the one that would break it, and audits the drop", async () => {
    const { second } = await withSecondStore(ctx);
    const data = new TextEncoder().encode("two copies, then one");
    await upload(data);
    const hash = hashOf(data);
    // The second store holds a copy: recorded the way replication records
    // one, after a put.
    await second.put(hash, {
      stream: Readable.from([Buffer.from(data)]),
      size_bytes: data.length,
    });
    await ctx.storage.blobs.recordLocation(hash, second.id);
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(2);

    // A working key is refused a drop the minimum would allow, and the
    // copy stays for the operator to drop.
    const working = await request(
      ctx.app,
      "DELETE",
      `/blobs/${hash}/locations/${second.id}`,
      { key: ctx.workingKey },
    );
    expect(working.status).toBe(403);
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(2);
    const dropped = await request(
      ctx.app,
      "DELETE",
      `/blobs/${hash}/locations/${second.id}`,
      { key: ctx.operatorKey },
    );
    expect(dropped.status).toBe(200);
    expect(await dropped.json()).toEqual({ ok: true });
    expect(
      (await ctx.storage.blobs.listLocations(hash)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    expect(await second.has(hash)).toBeNull();
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    const audits = await ctx.storage.audit.list({
      action: "blob.copy_dropped",
      limit: 10,
    });
    expect(audits.data.map((row) => row.resource_id)).toContain(hash);

    // The last copy is refused: the log and the bytes are untouched.
    const refused = await request(
      ctx.app,
      "DELETE",
      `/blobs/${hash}/locations/${ctx.blobs.disk.id}`,
      { key: ctx.operatorKey },
    );
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("copies_below_minimum");
    expect(body.error.details).toMatchObject({ live: 1, min_copies: 1 });
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(1);
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();

    // A store that holds no copy, and a store that is not attached.
    const nowhere = await request(
      ctx.app,
      "DELETE",
      `/blobs/${hash}/locations/${second.id}`,
      { key: ctx.operatorKey },
    );
    expect(nowhere.status).toBe(404);
    expect(
      ((await nowhere.json()) as { error: { code: string } }).error.code,
    ).toBe("blob_location_not_found");
    const unattached = await request(
      ctx.app,
      "DELETE",
      `/blobs/${hash}/locations/no-such-store`,
      { key: ctx.operatorKey },
    );
    expect(unattached.status).toBe(404);
    // An unknown blob, and a working key.
    const unknown = await request(
      ctx.app,
      "DELETE",
      `/blobs/sha256:${"0".repeat(64)}/locations/${ctx.blobs.disk.id}`,
      { key: ctx.operatorKey },
    );
    expect(unknown.status).toBe(404);
    expect(
      ((await unknown.json()) as { error: { code: string } }).error.code,
    ).toBe("blob_not_found");
  });
});
