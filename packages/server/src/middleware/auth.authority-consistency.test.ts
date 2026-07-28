/**
 * Regression suite for authority checks that were hand-rolled instead of
 * going through the shared auth helpers.
 *
 * The platform-admin gate was redefined as the `admin` role AND the
 * absence of a tenant binding, because `POST /admin/tenants/{id}/keys`
 * legitimately mints a tenant-bound credential at `role: "admin"` whose
 * reach is deliberately one tenant. Every route that spelled the gate as
 * a bare `role === "admin"` kept the old meaning and now disagrees with
 * `checkAdmin` — readmitting exactly the credential the gate exists to
 * exclude, on surfaces whose lookups are unfenced.
 *
 * The same shape runs the other way on the permission-map bypass: routes
 * spelling it as `role === "admin"` skip the `scope_enforced` carve-out
 * that holds an OAuth app to its granted scopes, and withhold the bypass
 * from the `tenant_admin` every hosted sign-up is provisioned as.
 *
 * Each site is covered twice: the credential that must be refused, and a
 * control proving the legitimate caller still gets through.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ApiKey } from "@withmarfa/shared";
import {
  hashApiKey,
  hasPlatformAuthority,
  hasTenantAdminAuthority,
  roleBypassesPermissionMaps,
  isReservedCredentialSource,
} from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import type { Storage } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Unit — the predicates the routes now share
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

describe("hasPlatformAuthority", () => {
  it("admits an unbound admin", () => {
    expect(hasPlatformAuthority(fakeKey("admin"))).toBe(true);
  });

  it("refuses a tenant-bound admin — the shape the escalation fix named", () => {
    expect(hasPlatformAuthority(fakeKey("admin", { tenant_id: "t-a" }))).toBe(
      false,
    );
  });

  it("refuses tenant_admin and member", () => {
    expect(hasPlatformAuthority(fakeKey("tenant_admin"))).toBe(false);
    expect(hasPlatformAuthority(fakeKey("member"))).toBe(false);
  });
});

describe("hasTenantAdminAuthority", () => {
  it("admits admin and tenant_admin, bound or not", () => {
    expect(hasTenantAdminAuthority(fakeKey("admin"))).toBe(true);
    expect(
      hasTenantAdminAuthority(fakeKey("admin", { tenant_id: "t-a" })),
    ).toBe(true);
    expect(hasTenantAdminAuthority(fakeKey("tenant_admin"))).toBe(true);
  });

  it("refuses member", () => {
    expect(hasTenantAdminAuthority(fakeKey("member"))).toBe(false);
  });
});

describe("roleBypassesPermissionMaps", () => {
  it("admits admin and tenant_admin", () => {
    expect(roleBypassesPermissionMaps(fakeKey("admin"))).toBe(true);
    expect(roleBypassesPermissionMaps(fakeKey("tenant_admin"))).toBe(true);
  });

  it("refuses a scope_enforced credential whatever its projected role", () => {
    // The OAuth synthetic principal projects the signed-in user's role.
    // An admin signing into a third-party app must not hand that app the
    // full surface — the grant is the ceiling, not the role.
    expect(
      roleBypassesPermissionMaps(fakeKey("admin", { scope_enforced: true })),
    ).toBe(false);
  });

  it("refuses member and a missing credential", () => {
    expect(roleBypassesPermissionMaps(fakeKey("member"))).toBe(false);
    expect(roleBypassesPermissionMaps(undefined)).toBe(false);
  });
});

describe("isReservedCredentialSource", () => {
  it("claims the three connector prefixes", () => {
    expect(isReservedCredentialSource("oauth:conn-1")).toBe(true);
    expect(isReservedCredentialSource("integration:conn-1")).toBe(true);
    expect(isReservedCredentialSource("runtime-abc-123")).toBe(true);
  });

  it("is case- and whitespace-insensitive, so the prefix cannot be smuggled", () => {
    expect(isReservedCredentialSource("  OAuth:conn-1")).toBe(true);
  });

  it("leaves ordinary sources alone", () => {
    expect(isReservedCredentialSource("my-laptop")).toBe(false);
    expect(isReservedCredentialSource("cli")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    oauthRedirectAllowlist: ["http://localhost:0/callback"],
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

function tenantStore(): NonNullable<Storage["tenants"]> {
  const tenants = ctx.storage.tenants;
  if (!tenants) throw new Error("test context has no tenant store");
  return tenants;
}

let mintCounter = 0;

async function mintKey(opts: {
  role: ApiKey["role"];
  tenantId?: string;
  is_platform?: boolean;
  label?: string;
  source?: string;
  extension_permissions?: Record<string, "read" | "write">;
}): Promise<string> {
  mintCounter += 1;
  const suffix = `${String(mintCounter)}${Math.random().toString(36).slice(2, 10)}`;
  const raw = `marfa_k1_authority_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: opts.label ?? `authority-${suffix}`,
      source: opts.source ?? `authority-${suffix}`,
      role: opts.role,
      default_tier: "library",
      type_permissions: {},
      extension_permissions: opts.extension_permissions,
      is_platform: opts.is_platform ?? false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    opts.tenantId,
  );
  return raw;
}

/** A `system.connection` of kind integration, seeded through storage so
 *  the test doesn't depend on the install pipeline. */
async function seedConnection(tenantId: string): Promise<string> {
  const conn = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: "acme.demo",
      },
    },
    tenantId,
  );
  return conn.id;
}

// ---------------------------------------------------------------------------
// POST /connections/:id/oauth/start
// ---------------------------------------------------------------------------

describe("POST /connections/:id/oauth/start — tenant fence on the connection lookup", () => {
  it("refuses a tenant-bound admin reaching a connection in another tenant", async () => {
    const tenantA = await tenantStore().create("authority-oauth-start-A");
    const tenantB = await tenantStore().create("authority-oauth-start-B");
    const victimConnection = await seedConnection(tenantB.id);

    // Exactly what `POST /admin/tenants/{id}/keys` mints: role admin,
    // bound to one tenant. The old gate tested the role alone and the
    // lookup passed no tenant, so this reached tenant B's connection.
    const boundAdmin = await mintKey({ role: "admin", tenantId: tenantA.id });

    // Guard the fixture: a mistyped id would make the 404 below pass for
    // the wrong reason, hiding a live cross-tenant read.
    expect(victimConnection).toMatch(/\w/);
    expect(await ctx.storage.items.get(victimConnection, tenantB.id)).not.toBe(
      null,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${victimConnection}/oauth/start`,
      {
        key: boundAdmin,
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );

    // 404, not 403 — a cross-tenant probe must not confirm the id exists.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("item_not_found");
  });

  it("admits a tenant_admin on its own tenant's connection", async () => {
    const tenant = await tenantStore().create("authority-oauth-start-own");
    const connectionId = await seedConnection(tenant.id);
    const tenantAdmin = await mintKey({
      role: "tenant_admin",
      tenantId: tenant.id,
    });

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/oauth/start`,
      {
        key: tenantAdmin,
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );

    // Reaches the credential resolution and fails there (this connection
    // has no credential_ref) rather than being refused at the gate. The
    // point is that it is no longer a 403: a tenant_admin owns the
    // connections in its own tenant, and every hosted account is one.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /keys — list / revoke / update
// ---------------------------------------------------------------------------

describe("/keys — the tenant fence keys on the binding, not the role", () => {
  it("hides other tenants' keys from a tenant-bound admin", async () => {
    const tenantA = await tenantStore().create("authority-keys-A");
    const tenantB = await tenantStore().create("authority-keys-B");
    await mintKey({
      role: "member",
      tenantId: tenantB.id,
      label: "tenant-b-secret-key",
    });
    const boundAdmin = await mintKey({ role: "admin", tenantId: tenantA.id });

    const res = await request(ctx.app, "GET", "/keys", { key: boundAdmin });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: { tenant_id?: string | null; label: string }[];
    };
    // The old fence only narrowed `role === "tenant_admin"`, so a bound
    // admin saw every key on the instance.
    expect(body.keys.every((k) => k.tenant_id === tenantA.id)).toBe(true);
    expect(body.keys.some((k) => k.label === "tenant-b-secret-key")).toBe(
      false,
    );
  });

  it("404s a tenant-bound admin revoking another tenant's key", async () => {
    const tenantA = await tenantStore().create("authority-keys-revoke-A");
    const tenantB = await tenantStore().create("authority-keys-revoke-B");
    await mintKey({
      role: "member",
      tenantId: tenantB.id,
      label: "victim-revoke",
    });
    const victim = (await ctx.storage.keys.list()).find(
      (k) => k.label === "victim-revoke",
    );
    if (!victim) throw new Error("seed key not found");
    const boundAdmin = await mintKey({ role: "admin", tenantId: tenantA.id });

    const res = await request(ctx.app, "DELETE", `/keys/${victim.id}`, {
      key: boundAdmin,
    });
    expect(res.status).toBe(404);

    // `keys.get` filters revoked rows, so a surviving row is the proof the
    // refused DELETE did not land.
    const after = await ctx.storage.keys.get(victim.id);
    expect(after).not.toBeNull();
  });

  it("404s a tenant-bound admin rewriting another tenant's key permissions", async () => {
    const tenantA = await tenantStore().create("authority-keys-update-A");
    const tenantB = await tenantStore().create("authority-keys-update-B");
    await mintKey({
      role: "member",
      tenantId: tenantB.id,
      label: "victim-update",
    });
    const victim = (await ctx.storage.keys.list()).find(
      (k) => k.label === "victim-update",
    );
    if (!victim) throw new Error("seed key not found");
    const boundAdmin = await mintKey({ role: "admin", tenantId: tenantA.id });

    const res = await request(ctx.app, "PATCH", `/keys/${victim.id}`, {
      key: boundAdmin,
      body: { type_permissions: { "*": "write" } },
    });
    expect(res.status).toBe(404);

    const after = await ctx.storage.keys.get(victim.id);
    expect(after?.type_permissions).toEqual({});
  });

  it("still lets an unbound platform admin see and address every tenant", async () => {
    const tenant = await tenantStore().create("authority-keys-control");
    await mintKey({
      role: "member",
      tenantId: tenant.id,
      label: "control-visible",
    });

    const res = await request(ctx.app, "GET", "/keys", { key: ctx.adminKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { label: string }[] };
    expect(body.keys.some((k) => k.label === "control-visible")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /keys — the reserved source prefixes
// ---------------------------------------------------------------------------

describe("POST /keys — connector source prefixes are not mintable", () => {
  it("refuses a source claiming a connection's connector identity", async () => {
    const tenant = await tenantStore().create("authority-source-reserve");
    const connectionId = await seedConnection(tenant.id);
    const tenantAdmin = await mintKey({
      role: "tenant_admin",
      tenantId: tenant.id,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: tenantAdmin,
      body: {
        label: "forged-connector",
        // Read by three connection routes as proof of connector identity.
        source: `oauth:${connectionId}`,
        role: "member",
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("still accepts an ordinary source", async () => {
    const tenant = await tenantStore().create("authority-source-ok");
    const tenantAdmin = await mintKey({
      role: "tenant_admin",
      tenantId: tenant.id,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: tenantAdmin,
      body: { label: "ordinary", source: "my-laptop", role: "member" },
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Extensions — permission-map bypass and the reserved-namespace gate
// ---------------------------------------------------------------------------

describe("extensions — the bypass follows the shared predicate", () => {
  it("gives a tenant_admin the read surface its rank implies", async () => {
    const tenant = await tenantStore().create("authority-ext-tenant-admin");
    const tenantAdmin = await mintKey({
      role: "tenant_admin",
      tenantId: tenant.id,
    });
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "ext-host" } },
      tenant.id,
    );
    await ctx.storage.metadata.setExtension(item.id, "vendor.sync", {
      cursor: "abc",
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items/${item.id}/extensions/vendor.sync`,
      { key: tenantAdmin },
    );
    // Previously fell through to `extension_permissions`, which is `{}`
    // on a fresh key — so the tier every hosted account is provisioned at
    // could not read its own items' extensions.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, unknown> | null;
    };
    expect(body.data).toEqual({ cursor: "abc" });
  });

  it("refuses a tenant-bound admin writing a reserved namespace", async () => {
    const tenant = await tenantStore().create("authority-ext-reserved");
    const boundAdmin = await mintKey({ role: "admin", tenantId: tenant.id });
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "reserved-host" } },
      tenant.id,
    );

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/system`,
      { key: boundAdmin, body: { injected: true } },
    );
    // Reserved namespaces are the metadata-layer twin of the reserved
    // type namespaces, which are gated on `is_platform`, not on rank.
    expect(res.status).toBe(403);
  });

  it("still admits an unbound platform admin on a reserved namespace", async () => {
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "reserved-control" } },
      undefined,
    );
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/system`,
      { key: ctx.adminKey, body: { ok: true } },
    );
    expect(res.status).toBe(200);
  });
});
