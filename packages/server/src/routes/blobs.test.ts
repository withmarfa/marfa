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
        Authorization: `Bearer ${ctx.adminKey}`,
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
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    const res2 = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
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
        Authorization: `Bearer ${ctx.adminKey}`,
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
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "text/plain",
      },
      body: original,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    const downloadRes = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: ctx.adminKey,
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
      key: ctx.adminKey,
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
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    const headRes = await request(ctx.app, "HEAD", `/blobs/${hash}`, {
      key: ctx.adminKey,
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("Content-Type")).toBe("text/plain");
    expect(headRes.headers.get("Content-Length")).toBe(String(data.length));
  });

  it("returns 404 for unknown hash", async () => {
    const fakeHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const headRes = await request(ctx.app, "HEAD", `/blobs/${fakeHash}`, {
      key: ctx.adminKey,
    });
    expect(headRes.status).toBe(404);
  });

  it("returns 400 for invalid hash format", async () => {
    const headRes = await request(ctx.app, "HEAD", "/blobs/sha256:invalid", {
      key: ctx.adminKey,
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
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(uploadRes.status).toBe(201);

    const cleanupRes = await request(
      ctx.app,
      "POST",
      "/blobs/cleanup?dry_run=true",
      { key: ctx.adminKey },
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
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    // Create an item referencing the blob via a custom field name
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
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
      { key: ctx.adminKey },
    );
    const body = (await cleanupRes.json()) as {
      total_blobs: number;
      referenced: number;
      orphaned: number;
    };
    expect(body.referenced).toBeGreaterThan(0);
  });

  it("removes orphaned blobs when not dry-run", async () => {
    const cleanupRes = await request(ctx.app, "POST", "/blobs/cleanup", {
      key: ctx.adminKey,
    });
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
});

describe("POST /blobs/reconcile", () => {
  it("defaults to dry_run=true and returns a report", async () => {
    // Upload a blob so there's something in both storage and DB
    const data = new TextEncoder().encode("reconcile test blob");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(uploadRes.status).toBe(201);

    const res = await request(ctx.app, "POST", "/blobs/reconcile", {
      key: ctx.adminKey,
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
      key: ctx.adminKey,
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
      { key: ctx.adminKey },
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
