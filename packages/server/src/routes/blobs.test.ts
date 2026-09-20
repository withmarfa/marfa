import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { sweepUnreferencedBlobs } from "../storage/blob-orphans.js";

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

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** An unreferenced upload in the corpus: one sweep, no dry run. */
async function sweep(): Promise<void> {
  await sweepUnreferencedBlobs({
    storage: ctx.storage,
    blobs: ctx.blobs,
    dryRun: false,
  });
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

  it("leaves no spool behind, whether the bytes were new or already held", async () => {
    const data = new TextEncoder().encode("spooled twice");
    await upload(data);
    await upload(data);
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
    await upload(original, "text/plain");

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
    await upload(original, "text/plain");
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
    await upload(original, "text/plain");
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
    await upload(original, "text/plain");
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
    await upload(original, "text/plain");
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
    expect((await upload(data)).status).toBe(201);
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
    await upload(data, "text/plain");

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
    await upload(data, "text/plain");
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
    await upload(data, "text/plain");
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

  it("names the instance's base URL, not the origin the request arrived on", async () => {
    const data = new TextEncoder().encode("host of the link");
    await upload(data, "text/plain");
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
    await upload(data, "text/plain");
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
    await upload(data, "text/plain");
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
    await upload(data, "text/plain");
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
    await upload(other, "text/plain");
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

  it("refuses an expired link", async () => {
    const data = new TextEncoder().encode("expiring link");
    await upload(data, "text/plain");
    const res = await request(
      ctx.app,
      "GET",
      `/blobs/${hashOf(data)}/url?ttl=1`,
      { key: ctx.workingKey },
    );
    const url = new URL(((await res.json()) as { url: string }).url);
    const live = await ctx.app.request(url.pathname + url.search);
    expect(live.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const fetched = await ctx.app.request(url.pathname + url.search);
    expect(fetched.status).toBe(401);
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
    await upload(data);
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

describe("the unreferenced-blob sweep", () => {
  it("removes a blob nothing references and keeps one an item names", async () => {
    const orphan = new TextEncoder().encode("orphan blob content");
    const named = new TextEncoder().encode("custom field blob");
    await upload(orphan);
    await upload(named);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "has a logo", logo_blob_hash: hashOf(named) },
      },
    });
    expect(created.status).toBe(201);

    await sweep();

    expect(await ctx.storage.blobs.get(hashOf(orphan))).toBeNull();
    expect(await ctx.blobs.disk.has(hashOf(orphan))).toBeNull();
    expect(await ctx.storage.blobs.get(hashOf(named))).not.toBeNull();
    expect(await ctx.blobs.disk.has(hashOf(named))).not.toBeNull();
  });

  it("keeps a blob referenced only by a trashed item", async () => {
    const data = new TextEncoder().encode("bytes only the bin points at");
    await upload(data);
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        state: "trashed",
        properties: {
          body: "in the bin, still holds a file",
          blob_ref: hashOf(data),
        },
      },
    });
    expect(createRes.status).toBe(201);

    await sweep();

    expect(await ctx.blobs.disk.has(hashOf(data))).not.toBeNull();
  });

  it("keeps a blob referenced only by an archived or revoked item", async () => {
    for (const [state, type, properties] of [
      ["archived", "core.note", { body: "archived, holds a file" }],
      ["revoked", "system.device", { name: "Revoked laptop", kind: "laptop" }],
    ] as const) {
      const data = new TextEncoder().encode(`bytes only ${state} points at`);
      await upload(data);
      // Written through the storage layer rather than `POST /items`, because
      // one of these rows is a `system.*` type and the reserved namespace is
      // closed to every credential. The claim here is about what the scan
      // keeps, not about which door wrote the row.
      await ctx.storage.items.create({
        type,
        tier: "library",
        state,
        properties: { ...properties, blob_ref: hashOf(data) },
        source: "test/blob-cleanup",
      });

      await sweep();

      expect(await ctx.blobs.disk.has(hashOf(data))).not.toBeNull();
    }
  });

  it("keeps a blob referenced only by version history", async () => {
    const data = new TextEncoder().encode("bytes only history points at");
    await upload(data);
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "carries a file", attachment_hash: hashOf(data) },
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      item: { id: string; version: number };
    };
    const patchRes = await request(
      ctx.app,
      "PATCH",
      `/items/${created.item.id}`,
      {
        key: ctx.workingKey,
        body: {
          properties: { attachment_hash: "replaced" },
          version: created.item.version,
        },
      },
    );
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    await sweep();

    expect(await ctx.blobs.disk.has(hashOf(data))).not.toBeNull();
  });

  it("removes the location rows with the blob", async () => {
    const data = new TextEncoder().encode("rows go with the bytes");
    await upload(data);
    expect(await ctx.storage.blobs.listLocations(hashOf(data))).toHaveLength(1);
    await sweep();
    expect(await ctx.storage.blobs.listLocations(hashOf(data))).toHaveLength(0);
    // The folder the spool and the marker live in is untouched.
    expect(await readdir(join(ctx.blobs.disk.locator))).toContain(
      ".marfa-store",
    );
  });
});
