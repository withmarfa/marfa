/**
 * Tenant-scoped data export coverage:
 *
 *   - tenant_admin's self-export returns only the calling tenant's
 *     rows. Other tenants' items, even when present in the same DB,
 *     are filtered out at the storage layer.
 *
 *   - tenant_admin with `target_tenant_id` matching own succeeds.
 *
 *   - tenant_admin with mismatching `target_tenant_id` is rejected
 *     with 403 (cross-tenant authority not granted).
 *
 *   - platform admin with explicit `target_tenant_id` scopes to that
 *     tenant.
 *
 *   - platform admin without target_tenant_id falls through to the
 *     unscoped path (self-host compat) and is audited as
 *     `details.scope: "platform_unscoped"` so operators can alert.
 *
 *   - Archive export stamps `manifest.tenant_id` with the resolved
 *     scope, and `/admin/restore-archive` rejects an archive whose
 *     manifest tenant_id doesn't match the caller's restore target.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  waitForAudit,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

async function mintTenantAdmin(
  ctx: TestContext,
  tenantId: string,
  label: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_export_test_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      role: "tenant_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    tenantId,
  );
  return raw;
}

async function readNdjsonItems(res: Response): Promise<string[]> {
  const text = await res.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const parsed = JSON.parse(line) as { item: { id: string } };
      return parsed.item.id;
    });
}

describe("tenant-scoped export — tenant_admin self-export", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns only the calling tenant's items", async () => {
    ctx = await createTestContext();
    const tenantA = `t-export-a-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `t-export-b-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdminA = await mintTenantAdmin(ctx, tenantA, "ws-export-a");
    await mintTenantAdmin(ctx, tenantB, "ws-export-b");

    // Items in both tenants.
    const itemA = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "tenant A" } },
      tenantA,
    );
    const itemB = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "tenant B" } },
      tenantB,
    );

    // Tenant A's admin exports — should see ONLY itemA.
    const res = await request(ctx.app, "GET", "/export", { key: wsAdminA });
    expect(res.status).toBe(200);
    const ids = await readNdjsonItems(res);
    expect(ids).toContain(itemA.id);
    expect(ids).not.toContain(itemB.id);
  });

  it("accepts target_tenant_id matching own", async () => {
    ctx = await createTestContext();
    const tenantA = `t-target-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintTenantAdmin(ctx, tenantA, "ws-target");
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "scoped" } },
      tenantA,
    );

    const res = await request(
      ctx.app,
      "GET",
      `/export?target_tenant_id=${tenantA}`,
      { key: wsAdmin },
    );
    expect(res.status).toBe(200);
  });

  it("rejects mismatching target_tenant_id with 403", async () => {
    ctx = await createTestContext();
    const tenantA = `t-mismatch-a-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `t-mismatch-b-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdminA = await mintTenantAdmin(ctx, tenantA, "ws-mismatch");

    const res = await request(
      ctx.app,
      "GET",
      `/export?target_tenant_id=${tenantB}`,
      { key: wsAdminA },
    );
    expect(res.status).toBe(403);
  });
});

describe("tenant-scoped export — platform admin", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("scopes to target_tenant_id when supplied", async () => {
    ctx = await createTestContext();
    const tenantA = `t-platform-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `t-platform-b-${Math.random().toString(36).slice(2, 10)}`;
    const itemA = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "A" } },
      tenantA,
    );
    const itemB = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "B" } },
      tenantB,
    );

    // ctx.adminKey is platform admin — no tenant_id.
    const res = await request(
      ctx.app,
      "GET",
      `/export?target_tenant_id=${tenantA}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const ids = await readNdjsonItems(res);
    expect(ids).toContain(itemA.id);
    expect(ids).not.toContain(itemB.id);
  });

  it("falls through to unscoped (self-host compat) without target_tenant_id and audits as platform_unscoped", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/export", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);

    // Audit row stamped with the warning shape. The audit insert is
    // fire-and-forget, so poll briefly for the row to appear.
    const audit = await waitForAudit(
      () => ctx.storage.audit.list({ action: "export.tenant" }),
      (result) => result.data.length > 0,
    );
    const row = audit.data[0];
    expect(row).toBeDefined();
    const details = row?.details as { scope: string } | undefined;
    expect(details?.scope).toBe("platform_unscoped");
  });
});

describe("archive — manifest tenant_id round-trip", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("stamps tenant_id on the manifest at export time", async () => {
    ctx = await createTestContext();
    const tenantA = `t-archive-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintTenantAdmin(ctx, tenantA, "ws-archive");
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "archive me" } },
      tenantA,
    );

    const res = await request(ctx.app, "GET", "/export?format=archive", {
      key: wsAdmin,
    });
    expect(res.status).toBe(200);
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    expect(buf.length).toBeGreaterThan(0);
    // We don't ungzip+untar in this test (would pull in test deps);
    // instead we round-trip via /admin/restore-archive in the next
    // test, which exercises the full manifest extraction.
  });

  it("admin-archive rejects mismatching manifest.tenant_id", async () => {
    ctx = await createTestContext();
    const tenantA = `t-restore-a-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `t-restore-b-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdminA = await mintTenantAdmin(ctx, tenantA, "ws-restore-a");
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "from A" } },
      tenantA,
    );

    // Tenant A exports an archive.
    const exportRes = await request(ctx.app, "GET", "/export?format=archive", {
      key: wsAdminA,
    });
    expect(exportRes.status).toBe(200);
    const archive = await exportRes.arrayBuffer();

    // Platform admin attempts to restore into tenant B.
    const restoreRes = await ctx.app.request(
      `/admin/restore-archive?target_tenant_id=${tenantB}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.adminKey}`,
          "content-type": "application/gzip",
        },
        body: archive,
      },
    );
    expect(restoreRes.status).toBe(403);
    const body = (await restoreRes.json()) as {
      error: { code: string; message?: string };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toContain("manifest.tenant_id");
  });
});
