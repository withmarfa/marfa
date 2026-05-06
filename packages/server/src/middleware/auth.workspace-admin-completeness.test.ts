/**
 * Wave B Part 2 — workspace_admin completeness pass.
 *
 * Coverage for the additions on top of the T-051 base:
 *
 *   - `checkTypeAccess` and `computeTypeFilter` admit `workspace_admin`
 *     with the same bypass admin gets — `workspace_admin` is the
 *     "admin within tenant" tier and shouldn't be additionally gated
 *     by `type_permissions`.
 *
 *   - `GET /tenants/me/quotas` returns the calling tenant's row for
 *     workspace_admin; rejects platform-admin (no tenant_id) with 400.
 *
 *   - `GET /keys` (widened): workspace_admin sees only own-tenant keys.
 *
 *   - `DELETE /keys/:id` (widened): workspace_admin can revoke own-
 *     tenant key; cross-tenant attempts surface as 404 (cloak).
 *
 *   - `DELETE /items/:id/purge` (widened): workspace_admin can purge
 *     own-tenant items.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ApiKey } from "@mymehq/shared";
import { checkTypeAccess, computeTypeFilter, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";

function fakeKey(
  role: ApiKey["role"],
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: "key-test",
    tenant_id: "tenant-test",
    label: "test",
    source: "test",
    role,
    is_platform: false,
    default_origin: "user",
    default_tier: "library",
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...overrides,
  };
}

async function mintKey(
  ctx: TestContext,
  opts: {
    label: string;
    role: ApiKey["role"];
    tenantId?: string;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `myme_k1_part2_test_${suffix}`;
  const keyHash = hashApiKey(raw, TEST_API_KEY_SALT);
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      role: opts.role,
      default_tier: "library",
      type_permissions: {},
    },
    keyHash,
    opts.tenantId,
  );
  return raw;
}

// ---------------------------------------------------------------------------
// Unit — type_permissions bypass + computeTypeFilter
// ---------------------------------------------------------------------------

describe("workspace_admin bypasses type_permissions", () => {
  it("checkTypeAccess returns silently for workspace_admin on any type", () => {
    const key = fakeKey("workspace_admin", { type_permissions: {} });
    expect(() => {
      checkTypeAccess(key, "core.note", "write");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(key, "demo.web_gallery", "write");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(key, "core.task", "read");
    }).not.toThrow();
  });

  it("checkTypeAccess still gates system.* writes on is_platform", () => {
    const key = fakeKey("workspace_admin", {
      type_permissions: {},
      is_platform: false,
    });
    // Reads to system.* are allowed; writes are not unless platform.
    expect(() => {
      checkTypeAccess(key, "system.connection", "read");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(key, "system.connection", "write");
    }).toThrow();
  });

  it("computeTypeFilter returns undefined (no filter) for workspace_admin", () => {
    const key = fakeKey("workspace_admin", {
      type_permissions: { "core.note": "read" },
    });
    expect(computeTypeFilter(key)).toBeUndefined();
  });

  it("computeTypeFilter still filters for member role", () => {
    const key = fakeKey("member", {
      type_permissions: { "core.note": "read", "core.task": "write" },
    });
    const filter = computeTypeFilter(key);
    expect(filter).toEqual(expect.arrayContaining(["core.note", "core.task"]));
  });
});

// ---------------------------------------------------------------------------
// Integration — widened routes + new GET /tenants/me/quotas
// ---------------------------------------------------------------------------

describe("GET /tenants/me/quotas", () => {
  let ctx: TestContext;

  afterEach(() => {
    ctx.cleanup();
  });

  it("returns the calling tenant's quota row for workspace_admin", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-quota-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-quota",
      role: "workspace_admin",
      tenantId: tenantA,
    });

    // Pre-populate a quota row via the storage layer.
    await ctx.storage.tenantQuotas.set(tenantA, { items_limit: 42 });

    const res = await request(ctx.app, "GET", "/tenants/me/quotas", {
      key: wsAdmin,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tenant_id).toBe(tenantA);
    expect(body.items_limit).toBe(42);
    expect(body.webhooks_limit).toBe(null);
  });

  it("rejects platform-admin (no tenant_id) with 400", async () => {
    ctx = await createTestContext();
    // ctx.adminKey is the bootstrap platform admin — no tenant_id.
    const res = await request(ctx.app, "GET", "/tenants/me/quotas", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("rejects member with FORBIDDEN", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-quota-mem-${Math.random().toString(36).slice(2, 10)}`;
    const member = await mintKey(ctx, {
      label: "member-quota",
      role: "member",
      tenantId: tenantA,
    });
    const res = await request(ctx.app, "GET", "/tenants/me/quotas", {
      key: member,
    });
    expect(res.status).toBe(403);
  });
});

describe("widened routes — keys + items.purge", () => {
  let ctx: TestContext;

  afterEach(() => {
    ctx.cleanup();
  });

  it("workspace_admin GET /keys lists only own-tenant keys", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-keys-a-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `tenant-keys-b-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdminA = await mintKey(ctx, {
      label: "ws-keys-a",
      role: "workspace_admin",
      tenantId: tenantA,
    });
    // Mint a tenant B key — workspace_admin in tenant A should not see it.
    await mintKey(ctx, {
      label: "ws-keys-b",
      role: "workspace_admin",
      tenantId: tenantB,
    });

    const res = await request(ctx.app, "GET", "/keys", { key: wsAdminA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { tenant_id: string | null }[] };
    // Every visible key has tenant_id === tenantA. None from tenant B.
    for (const k of body.keys) {
      expect(k.tenant_id).toBe(tenantA);
    }
    expect(body.keys.length).toBeGreaterThan(0);
  });

  it("workspace_admin DELETE /keys/:id of cross-tenant key returns 404", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-rev-a-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `tenant-rev-b-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdminA = await mintKey(ctx, {
      label: "ws-rev-a",
      role: "workspace_admin",
      tenantId: tenantA,
    });
    // Mint a key in tenant B; capture its id directly from the store
    // (tests don't need the raw key, just the row id).
    await mintKey(ctx, {
      label: "ws-rev-b",
      role: "workspace_admin",
      tenantId: tenantB,
    });
    const allKeys = await ctx.storage.keys.list();
    const tenantBKey = allKeys.find((k) => k.tenant_id === tenantB);
    expect(tenantBKey).toBeDefined();

    const res = await request(
      ctx.app,
      "DELETE",
      `/keys/${tenantBKey?.id ?? ""}`,
      { key: wsAdminA },
    );
    expect(res.status).toBe(404);
  });

  it("workspace_admin can purge an item in own tenant", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-purge-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-purge",
      role: "workspace_admin",
      tenantId: tenantA,
    });

    // Create + trash an item via storage so the test doesn't have to
    // model the full lifecycle through HTTP.
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "doomed" } },
      tenantA,
    );
    await ctx.storage.items.transition(item.id, "trashed", tenantA);

    const res = await request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
      key: wsAdmin,
    });
    expect(res.status).toBe(200);

    const after = await ctx.storage.items.get(item.id, tenantA);
    expect(after).toBeNull();
  });
});
