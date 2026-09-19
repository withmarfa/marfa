import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /blobs", () => {
  it("uploads a binary blob and returns hash", async () => {
    const data = new TextEncoder().encode("Hello, blob world!");
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      hash: string;
      mime_type: string;
      size: number;
    };
    expect(body.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.mime_type).toBe("application/octet-stream");
    expect(body.size).toBe(data.length);
  });

  it("deduplicates identical content", async () => {
    const data = new TextEncoder().encode("duplicate content test");
    const res1 = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    const res2 = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    const body1 = (await res1.json()) as { hash: string };
    const body2 = (await res2.json()) as { hash: string };
    expect(body1.hash).toBe(body2.hash);
  });

  it("rejects empty blob", async () => {
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const data = new TextEncoder().encode("no auth");
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: data,
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /blobs/:hash", () => {
  it("downloads a previously uploaded blob", async () => {
    const original = new TextEncoder().encode("round-trip test data");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: original,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    const downloadRes = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: ctx.workingKey,
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Content-Type")).toBe("text/plain");

    const downloaded = new Uint8Array(await downloadRes.arrayBuffer());
    expect(downloaded).toEqual(original);
  });

  it("returns 404 for unknown hash", async () => {
    const fakeHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const res = await request(ctx.app, "GET", `/blobs/${fakeHash}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(404);
  });
});

describe("HEAD /blobs/:hash", () => {
  it("returns 200 with headers for existing blob", async () => {
    const data = new TextEncoder().encode("head check data");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    const headRes = await request(ctx.app, "HEAD", `/blobs/${hash}`, {
      key: ctx.workingKey,
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("Content-Type")).toBe("text/plain");
    expect(headRes.headers.get("Content-Length")).toBe(String(data.length));
  });

  it("returns 404 for unknown hash", async () => {
    const fakeHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
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
    const fakeHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const headRes = await ctx.app.request(`/blobs/${fakeHash}`, {
      method: "HEAD",
    });
    expect(headRes.status).toBe(401);
  });
});

describe("POST /blobs/cleanup", () => {
  it("reports orphaned blobs in dry-run mode", async () => {
    // Upload a blob without creating an item referencing it
    const data = new TextEncoder().encode("orphan blob content");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(uploadRes.status).toBe(201);

    const cleanupRes = await request(
      ctx.app,
      "POST",
      "/blobs/cleanup?dry_run=true",
      { key: ctx.operatorKey },
    );
    expect(cleanupRes.status).toBe(200);
    const body = (await cleanupRes.json()) as {
      total_blobs: number;
      orphaned: number;
      removed: number;
      dry_run: boolean;
    };
    expect(body.dry_run).toBe(true);
    expect(body.removed).toBe(0);
    expect(body.orphaned).toBeGreaterThan(0);
  });

  it("detects blob hashes in non-standard property fields", async () => {
    // Upload a blob and reference it via a non-standard field name
    const data = new TextEncoder().encode("custom field blob");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    // Create an item referencing the blob via a custom field name
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "has a logo", logo_blob_hash: hash },
      },
    });

    // The blob referenced via logo_blob_hash should be detected as referenced
    const cleanupRes = await request(
      ctx.app,
      "POST",
      "/blobs/cleanup?dry_run=true",
      { key: ctx.operatorKey },
    );
    const body = (await cleanupRes.json()) as {
      total_blobs: number;
      referenced: number;
      orphaned: number;
    };
    expect(body.referenced).toBeGreaterThan(0);
  });

  it("defaults to dry run, so an argument-less call deletes nothing", async () => {
    const data = new TextEncoder().encode("default-safety orphan blob");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    const cleanupRes = await request(ctx.app, "POST", "/blobs/cleanup", {
      key: ctx.operatorKey,
    });
    expect(cleanupRes.status).toBe(200);
    const body = (await cleanupRes.json()) as {
      orphaned: number;
      removed: number;
      dry_run: boolean;
    };
    expect(body.dry_run).toBe(true);
    expect(body.removed).toBe(0);
    expect(body.orphaned).toBeGreaterThan(0);

    // The orphan is untouched: deletion always requires an explicit ask.
    const headRes = await ctx.app.request(`/blobs/${hash}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(headRes.status).toBe(200);
  });

  it("removes orphaned blobs when dry_run=false is passed explicitly", async () => {
    const cleanupRes = await request(
      ctx.app,
      "POST",
      "/blobs/cleanup?dry_run=false",
      { key: ctx.operatorKey },
    );
    expect(cleanupRes.status).toBe(200);
    const body = (await cleanupRes.json()) as {
      total_blobs: number;
      orphaned: number;
      removed: number;
      dry_run: boolean;
    };
    expect(body.dry_run).toBe(false);
    expect(body.removed).toBe(body.orphaned);
  });

  /**
   * The scan used to walk the corpus twice — once bare, which applies the
   * default that hides the bin, and once with the state pinned to
   * `trashed` — purely to see all four states. It is one pass with
   * `all_states` now, and nothing covered the pinned pass, so a collapse
   * that dropped the bin would have been silently destructive: a blob
   * referenced only by a trashed item would be deleted out from under the
   * restore that is the whole reason the bin exists.
   */
  it("keeps a blob referenced only by a trashed item", async () => {
    const data = new TextEncoder().encode("bytes only the bin points at");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        state: "trashed",
        properties: { body: "in the bin, still holds a file", blob_ref: hash },
      },
    });
    expect(createRes.status).toBe(201);

    const cleanupRes = await request(
      ctx.app,
      "POST",
      "/blobs/cleanup?dry_run=false",
      { key: ctx.operatorKey },
    );
    expect(cleanupRes.status).toBe(200);

    // The blob is still readable, which is the property. A count of
    // orphans would pass whether or not this particular hash survived.
    const headRes = await ctx.app.request(`/blobs/${hash}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(headRes.status).toBe(200);
  });

  /** The archived and revoked states reach the scan through the bare
   *  listing's default rather than through the pinned pass, so they were
   *  covered only incidentally. Named here so the widening is checked on
   *  every state rather than on the one that changed. */
  it("keeps a blob referenced only by an archived or revoked item", async () => {
    for (const [state, type, properties] of [
      ["archived", "core.note", { body: "archived, holds a file" }],
      ["revoked", "system.device", { name: "Revoked laptop", kind: "laptop" }],
    ] as const) {
      const data = new TextEncoder().encode(`bytes only ${state} points at`);
      const uploadRes = await ctx.app.request("/blobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.workingKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: data,
      });
      const { hash } = (await uploadRes.json()) as { hash: string };

      // Written through the storage layer rather than `POST /items`, because
      // one of these rows is a `system.*` type and the reserved namespace is
      // closed to every credential. The claim here is about what
      // the cleanup scan keeps, not about which door wrote the row.
      await ctx.storage.items.create({
        type,
        tier: "library",
        state,
        properties: { ...properties, blob_ref: hash },
        source: "test/blob-cleanup",
      });

      const cleanupRes = await request(
        ctx.app,
        "POST",
        "/blobs/cleanup?dry_run=false",
        { key: ctx.operatorKey },
      );
      expect(cleanupRes.status).toBe(200);

      const headRes = await ctx.app.request(`/blobs/${hash}`, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${ctx.workingKey}` },
      });
      expect(headRes.status).toBe(200);
    }
  });

  it("keeps a blob referenced only by version history", async () => {
    const data = new TextEncoder().encode("bytes only history points at");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    // Reference the blob from a live item, then overwrite the referencing
    // key so the hash survives only in the version snapshot of the old
    // state.
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "carries a file", attachment_hash: hash },
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      item: { id: string; version: number };
    };
    const id = created.item.id;
    const patchRes = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: {
        properties: { attachment_hash: "replaced" },
        version: created.item.version,
      },
    });
    if (patchRes.status !== 200) {
      throw new Error(`patch failed: ${await patchRes.text()}`);
    }

    const cleanupRes = await request(
      ctx.app,
      "POST",
      "/blobs/cleanup?dry_run=false",
      { key: ctx.operatorKey },
    );
    expect(cleanupRes.status).toBe(200);

    // The bytes a version still points at must survive the cleanup.
    const headRes = await ctx.app.request(`/blobs/${hash}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(headRes.status).toBe(200);
  });
});

describe("POST /blobs/reconcile", () => {
  it("defaults to dry_run=true and returns a report", async () => {
    // Upload a blob so there's something in both storage and DB
    const data = new TextEncoder().encode("reconcile test blob");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(uploadRes.status).toBe(201);

    const res = await request(ctx.app, "POST", "/blobs/reconcile", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      s3_total: number;
      db_total: number;
      healthy: number;
      orphaned_s3: number;
      missing_s3: number;
      orphaned_s3_sample: string[];
      missing_s3_sample: string[];
      deleted: number;
      dry_run: boolean;
    };
    expect(body.dry_run).toBe(true);
    expect(body.deleted).toBe(0);
    expect(body.healthy).toBeGreaterThan(0);
    expect(body.s3_total).toBe(body.db_total);
    expect(body.orphaned_s3).toBe(0);
    expect(body.missing_s3).toBe(0);
  });

  it("detects orphaned storage files not in DB", async () => {
    // Write a file directly to the blob backend (bypassing DB registration)
    const orphanHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000099999";
    await ctx.blobBackend.put(orphanHash, Buffer.from("orphan data"));

    const res = await request(ctx.app, "POST", "/blobs/reconcile", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orphaned_s3: number;
      orphaned_s3_sample: string[];
      deleted: number;
      dry_run: boolean;
    };
    expect(body.dry_run).toBe(true);
    expect(body.orphaned_s3).toBeGreaterThan(0);
    expect(body.orphaned_s3_sample).toContain(orphanHash);
    expect(body.deleted).toBe(0);
  });

  it("deletes orphaned storage files in execute mode", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/blobs/reconcile?dry_run=false",
      { key: ctx.operatorKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orphaned_s3: number;
      deleted: number;
      dry_run: boolean;
    };
    expect(body.dry_run).toBe(false);
    expect(body.deleted).toBe(body.orphaned_s3);

    // Verify the orphan file is gone
    const orphanHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000099999";
    expect(await ctx.blobBackend.exists(orphanHash)).toBe(false);
  });

  it("requires authentication", async () => {
    const res = await ctx.app.request("/blobs/reconcile", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
