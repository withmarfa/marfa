/**
 * Blob storage tenant scoping.
 *
 * Cross-tenant probes for the same hash bytes return 404 even though the
 * underlying file is shared via content-addressed deduplication. Each
 * tenant's metadata row is private; the empty-string sentinel covers
 * platform-admin / single-tenant uploads so existing self-hosts continue
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

async function mintTenantAdmin(
  ctx: TestContext,
  label: string,
  tenantId: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_blob_test_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      role: "tenant_admin",
      default_tier: "library",
      type_permissions: {},
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    tenantId,
  );
  return raw;
}

describe("blobs — tenant scoping", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("tenant B cannot fetch a blob uploaded by tenant A (cross-tenant probe is 404)", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-a-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `tenant-b-${Math.random().toString(36).slice(2, 10)}`;
    const adminA = await mintTenantAdmin(ctx, "blob-admin-a", tenantA);
    const adminB = await mintTenantAdmin(ctx, "blob-admin-b", tenantB);

    // A uploads
    const upload = await request(ctx.app, "POST", "/blobs", {
      key: adminA,
      headers: { "Content-Type": "application/octet-stream" },
      body: "tenant-a-secret",
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

  it("tenant B uploading the same bytes gets their own row; both can read independently", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-a-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `tenant-b-${Math.random().toString(36).slice(2, 10)}`;
    const adminA = await mintTenantAdmin(ctx, "blob-admin-a-2", tenantA);
    const adminB = await mintTenantAdmin(ctx, "blob-admin-b-2", tenantB);

    const sameBytes = "shared-content-different-tenants";
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

    // Both tenants can independently fetch
    const getA = await request(ctx.app, "GET", `/blobs/${hashA}`, {
      key: adminA,
    });
    expect(getA.status).toBe(200);
    const getB = await request(ctx.app, "GET", `/blobs/${hashB}`, {
      key: adminB,
    });
    expect(getB.status).toBe(200);
  });

  it("platform-admin upload (no tenant_id) goes to instance-wide sentinel; tenant probes still 404", async () => {
    // The default test admin has no tenant_id — its upload goes to the
    // empty-string sentinel row.
    ctx = await createTestContext();
    const tenantA = `tenant-a-${Math.random().toString(36).slice(2, 10)}`;
    const adminA = await mintTenantAdmin(ctx, "blob-admin-iso", tenantA);

    const upload = await request(ctx.app, "POST", "/blobs", {
      key: ctx.adminKey, // platform admin (no tenant)
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

    // Tenant-bound caller cannot fetch the platform-admin's blob
    // (different tenant scopes — empty-string sentinel ≠ tenant A)
    const getA = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: adminA,
    });
    expect(getA.status).toBe(404);
  });
});
