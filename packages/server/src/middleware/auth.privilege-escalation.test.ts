/**
 * Regression suite for the role axis of credential minting and for the
 * platform-admin gate.
 *
 * Two independent defects, one escalation chain:
 *
 * 1. `POST /keys` took `role` straight from the request body. A
 *    `tenant_admin` could mint itself an `admin` credential — and every
 *    hosted sign-up is provisioned `tenant_admin`, so any account could
 *    reach platform authority. The fix is a role lattice: a caller may
 *    never grant a role that outranks its own.
 *
 * 2. `checkAdmin` tested the role alone. A credential carrying
 *    `role: "admin"` but bound to a tenant passed every `requireAdmin`
 *    gate, including the cross-tenant `/admin/tenants` surface. Platform
 *    authority is authority that is NOT confined to a tenant, so the gate
 *    now requires an unbound credential.
 *
 * Each layer is tested on its own: the lattice holds even if a
 * tenant-bound admin key is minted by a platform operator through
 * `POST /admin/tenants/{id}/keys`, and the platform gate holds even if a
 * tenant-bound admin credential exists for any other reason.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ApiKey } from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { checkAdmin, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import type { Storage } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Unit — checkAdmin considers tenant binding, not role alone
// ---------------------------------------------------------------------------

function fakeKey(
  role: ApiKey["role"],
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: "key-test",
    label: "test",
    source: "test",
    role,
    is_platform: false,
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

describe("checkAdmin (unit)", () => {
  it("admits an unbound admin — the platform operator credential", () => {
    const key = fakeKey("admin");
    expect(checkAdmin(key)).toBe(key);
  });

  it("rejects a tenant-bound admin with FORBIDDEN", () => {
    const key = fakeKey("admin", { tenant_id: "tenant-a" });
    expect(() => checkAdmin(key)).toThrow(MarfaError);
    try {
      checkAdmin(key);
    } catch (e) {
      expect((e as MarfaError).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("rejects tenant_admin", () => {
    expect(() => checkAdmin(fakeKey("tenant_admin"))).toThrow(MarfaError);
  });

  it("rejects member", () => {
    expect(() => checkAdmin(fakeKey("member"))).toThrow(MarfaError);
  });

  it("rejects undefined with UNAUTHORIZED", () => {
    try {
      checkAdmin(undefined);
      expect.unreachable("checkAdmin must throw for a missing credential");
    } catch (e) {
      expect((e as MarfaError).code).toBe(ErrorCode.UNAUTHORIZED);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

/** The tenant store is optional on the interface but always present in a
 *  test context built with the default (hosted-capable) storage. */
function tenantStore(ctx: TestContext): NonNullable<Storage["tenants"]> {
  const tenants = ctx.storage.tenants;
  if (!tenants) throw new Error("test context has no tenant store");
  return tenants;
}

async function mintKey(
  ctx: TestContext,
  opts: {
    label: string;
    role: ApiKey["role"];
    tenantId?: string;
    is_platform?: boolean;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_escalation_test_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      role: opts.role,
      default_tier: "library",
      type_permissions: {},
      is_platform: opts.is_platform ?? false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    opts.tenantId,
  );
  return raw;
}

describe("role lattice — a caller cannot grant above its own authority", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("tenant_admin cannot mint an admin credential", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-a-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-lattice",
      role: "tenant_admin",
      tenantId: tenantA,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: wsAdmin,
      body: {
        label: "escalated",
        source: "escalated",
        role: "admin",
        default_tier: "library",
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("tenant_admin may still mint its own tier and below", async () => {
    ctx = await createTestContext();
    const tenantA = `tenant-a-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-peer",
      role: "tenant_admin",
      tenantId: tenantA,
    });

    for (const role of ["tenant_admin", "member"] as const) {
      const res = await request(ctx.app, "POST", "/keys", {
        key: wsAdmin,
        body: {
          label: `peer-${role}`,
          source: `peer-${role}`,
          role,
          default_tier: "library",
        },
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { role: string }).role).toBe(role);
    }
  });

  it("a platform admin may still mint any role", async () => {
    ctx = await createTestContext();
    const platform = await mintKey(ctx, {
      label: "platform-admin",
      role: "admin",
      is_platform: true,
    });

    for (const role of ["admin", "tenant_admin", "member"] as const) {
      const res = await request(ctx.app, "POST", "/keys", {
        key: platform,
        body: {
          label: `minted-${role}`,
          source: `minted-${role}`,
          role,
          default_tier: "library",
        },
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { role: string }).role).toBe(role);
    }
  });

  it("a tenant-bound admin cannot mint above tenant scope either", async () => {
    // A platform operator can legitimately issue a tenant-bound `admin`
    // through POST /admin/tenants/{id}/keys. Its authority is confined to
    // that tenant, so its mint ceiling must be too.
    ctx = await createTestContext();
    const tenantA = `tenant-a-${Math.random().toString(36).slice(2, 10)}`;
    const boundAdmin = await mintKey(ctx, {
      label: "bound-admin",
      role: "admin",
      tenantId: tenantA,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: boundAdmin,
      body: {
        label: "child-admin",
        source: "child-admin",
        role: "admin",
        default_tier: "library",
      },
    });

    // Same tier, so the lattice permits it; the minted key inherits the
    // caller's tenant binding and is therefore no more powerful.
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.tenant_id).toBe(tenantA);
  });
});

describe("platform gate — a tenant-bound admin has no cross-tenant authority", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function seedBoundAdmin(): Promise<{
    boundAdmin: string;
    victim: string;
  }> {
    const victim = (await tenantStore(ctx).create("Victim Space")).id;
    const attacker = (await tenantStore(ctx).create("Attacker Space")).id;
    const boundAdmin = await mintKey(ctx, {
      label: "bound-admin",
      role: "admin",
      tenantId: attacker,
    });
    return { boundAdmin, victim };
  }

  it("cannot enumerate tenants", async () => {
    ctx = await createTestContext();
    const { boundAdmin } = await seedBoundAdmin();

    const res = await request(ctx.app, "GET", "/admin/tenants", {
      key: boundAdmin,
    });
    expect(res.status).toBe(403);
  });

  it("cannot read another tenant's row", async () => {
    ctx = await createTestContext();
    const { boundAdmin, victim } = await seedBoundAdmin();

    const res = await request(ctx.app, "GET", `/admin/tenants/${victim}`, {
      key: boundAdmin,
    });
    expect(res.status).toBe(403);
  });

  it("cannot suspend another tenant", async () => {
    ctx = await createTestContext();
    const { boundAdmin, victim } = await seedBoundAdmin();

    const res = await request(
      ctx.app,
      "POST",
      `/admin/tenants/${victim}/suspend`,
      { key: boundAdmin, body: {} },
    );
    expect(res.status).toBe(403);

    const after = await tenantStore(ctx).get(victim);
    expect(after?.status).toBe("active");
  });

  it("cannot mint a credential inside another tenant", async () => {
    ctx = await createTestContext();
    const { boundAdmin, victim } = await seedBoundAdmin();

    const res = await request(
      ctx.app,
      "POST",
      `/admin/tenants/${victim}/keys`,
      {
        key: boundAdmin,
        body: { label: "foothold", source: "foothold", role: "tenant_admin" },
      },
    );
    expect(res.status).toBe(403);
  });

  it("cannot rewrite another tenant's quotas", async () => {
    ctx = await createTestContext();
    const { boundAdmin, victim } = await seedBoundAdmin();

    const res = await request(ctx.app, "PUT", `/tenants/${victim}/quotas`, {
      key: boundAdmin,
      body: { items_limit: 1 },
    });
    expect(res.status).toBe(403);
  });

  it("an unbound platform admin still reaches all of it", async () => {
    ctx = await createTestContext();
    const victim = (await tenantStore(ctx).create("Victim Space")).id;
    const platform = await mintKey(ctx, {
      label: "platform-admin",
      role: "admin",
      is_platform: true,
    });

    expect(
      (await request(ctx.app, "GET", "/admin/tenants", { key: platform }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app, "POST", `/admin/tenants/${victim}/suspend`, {
          key: platform,
          body: {},
        })
      ).status,
    ).toBe(200);
  });
});

describe("tenant config is tenant-scoped self-service", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("tenant_admin reads and writes its own tenant config", async () => {
    ctx = await createTestContext();
    const tenant = (await tenantStore(ctx).create("Own Space")).id;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-config",
      role: "tenant_admin",
      tenantId: tenant,
    });

    const put = await request(ctx.app, "PUT", "/tenants/me/config", {
      key: wsAdmin,
      body: { trash_retention_days: 7 },
    });
    expect(put.status).toBe(200);

    const get = await request(ctx.app, "GET", "/tenants/me/config", {
      key: wsAdmin,
    });
    expect(get.status).toBe(200);
    expect((await get.json()) as Record<string, unknown>).toMatchObject({
      trash_retention_days: 7,
    });

    // The write landed on the caller's own tenant, not somewhere else.
    const stored = await tenantStore(ctx).getConfig(tenant);
    expect(stored?.trash_retention_days).toBe(7);
  });

  it("member is still rejected", async () => {
    ctx = await createTestContext();
    const tenant = (await tenantStore(ctx).create("Own Space")).id;
    const member = await mintKey(ctx, {
      label: "member-config",
      role: "member",
      tenantId: tenant,
    });

    const res = await request(ctx.app, "GET", "/tenants/me/config", {
      key: member,
    });
    expect(res.status).toBe(403);
  });
});
