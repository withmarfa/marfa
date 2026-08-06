/**
 * Blob storage space scoping.
 *
 * Cross-space probes for the same hash bytes return 404 even though the
 * underlying file is shared via content-addressed deduplication. Each
 * space's metadata row is private; the empty-string sentinel covers
 * platform-admin / single-space uploads so existing self-hosts continue
 * to work unchanged.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

async function mintSpaceAdmin(
  ctx: TestContext,
  label: string,
  spaceId: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_blob_test_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      role: "space_admin",
      default_tier: "library",
      type_permissions: {},
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

describe("blobs — space scoping", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("space B cannot fetch a blob uploaded by space A (cross-space probe is 404)", async () => {
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `space-b-${Math.random().toString(36).slice(2, 10)}`;
    const adminA = await mintSpaceAdmin(ctx, "blob-admin-a", spaceA);
    const adminB = await mintSpaceAdmin(ctx, "blob-admin-b", spaceB);

    // A uploads
    const upload = await request(ctx.app, "POST", "/blobs", {
      key: adminA,
      headers: { "Content-Type": "application/octet-stream" },
      body: "space-a-secret",
    });
    expect(upload.status).toBe(201);
    const { hash } = (await upload.json()) as { hash: string };

    // A can fetch
    const getA = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: adminA,
    });
    expect(getA.status).toBe(200);

    // B cannot fetch even though they know the hash
    const getB = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: adminB,
    });
    expect(getB.status).toBe(404);

    // B's HEAD probe also returns 404
    const headB = await request(ctx.app, "HEAD", `/blobs/${hash}`, {
      key: adminB,
    });
    expect(headB.status).toBe(404);
  });

  it("space B uploading the same bytes gets their own row; both can read independently", async () => {
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `space-b-${Math.random().toString(36).slice(2, 10)}`;
    const adminA = await mintSpaceAdmin(ctx, "blob-admin-a-2", spaceA);
    const adminB = await mintSpaceAdmin(ctx, "blob-admin-b-2", spaceB);

    const sameBytes = "shared-content-different-spaces";
    const headers = { "Content-Type": "application/octet-stream" };

    const upA = await request(ctx.app, "POST", "/blobs", {
      key: adminA,
      headers,
      body: sameBytes,
    });
    expect(upA.status).toBe(201);
    const { hash: hashA } = (await upA.json()) as { hash: string };

    const upB = await request(ctx.app, "POST", "/blobs", {
      key: adminB,
      headers,
      body: sameBytes,
    });
    expect(upB.status).toBe(201);
    const { hash: hashB } = (await upB.json()) as { hash: string };

    expect(hashA).toBe(hashB);

    // Both spaces can independently fetch
    const getA = await request(ctx.app, "GET", `/blobs/${hashA}`, {
      key: adminA,
    });
    expect(getA.status).toBe(200);
    const getB = await request(ctx.app, "GET", `/blobs/${hashB}`, {
      key: adminB,
    });
    expect(getB.status).toBe(200);
  });

  it("platform-admin upload (no space_id) goes to instance-wide sentinel; space probes still 404", async () => {
    // The default test admin has no space_id — its upload goes to the
    // empty-string sentinel row.
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const adminA = await mintSpaceAdmin(ctx, "blob-admin-iso", spaceA);

    const upload = await request(ctx.app, "POST", "/blobs", {
      key: ctx.adminKey, // platform admin (no space)
      headers: { "Content-Type": "application/octet-stream" },
      body: "platform-admin-content",
    });
    expect(upload.status).toBe(201);
    const { hash } = (await upload.json()) as { hash: string };

    // Platform admin can fetch
    const getPlatform = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: ctx.adminKey,
    });
    expect(getPlatform.status).toBe(200);

    // Space-bound caller cannot fetch the platform-admin's blob
    // (different space scopes — empty-string sentinel ≠ space A)
    const getA = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: adminA,
    });
    expect(getA.status).toBe(404);
  });
  it("platform authority reads a blob that lives in a space", async () => {
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const adminA = await mintSpaceAdmin(ctx, "blob-admin-platform", spaceA);

    // Uploaded by a space-bound caller, so the only row is space A's.
    const upload = await request(ctx.app, "POST", "/blobs", {
      key: adminA,
      headers: { "Content-Type": "application/octet-stream" },
      body: "owned-by-space-a",
    });
    expect(upload.status).toBe(201);
    const { hash } = (await upload.json()) as { hash: string };

    // The platform credential reads every space's items, so being told this
    // blob is absent is both wrong and the dangerous direction: absence is
    // what a repair or a purge acts on.
    const headPlatform = await request(ctx.app, "HEAD", `/blobs/${hash}`, {
      key: ctx.adminKey,
    });
    expect(headPlatform.status).toBe(200);

    const getPlatform = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: ctx.adminKey,
    });
    expect(getPlatform.status).toBe(200);

    // `/blobs/:hash/url` shares the same resolver but is presigned-only, so
    // it refuses before the lookup on the filesystem backend these tests use
    // and cannot witness the change here.

    // The space fence is untouched: another space still sees nothing.
    const spaceB = `space-b-${Math.random().toString(36).slice(2, 10)}`;
    const adminB = await mintSpaceAdmin(ctx, "blob-admin-other", spaceB);
    const getB = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: adminB,
    });
    expect(getB.status).toBe(404);
  });
});
