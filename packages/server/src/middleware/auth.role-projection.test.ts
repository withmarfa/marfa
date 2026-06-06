/**
 * Bearer middleware role projection for OAuth principals.
 *
 * The middleware reads the underlying `users.role` for the auth_user the
 * token was issued to, so admin-gated routes work for OAuth-authenticated
 * admins. The `is_platform` ceiling stays hardcoded false on OAuth
 * principals — platform-admin is an operator-tier flag exclusive to API
 * keys with explicit `is_platform: true`; OAuth tokens never claim it.
 *
 * Tests run hosted-mode (`storage.users` present) so the role-projection
 * lookup has a `users` row to consult.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { request, createTestContext, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterEach(async () => {
  await ctx.cleanup();
});

function tenants() {
  if (!ctx.storage.tenants) {
    throw new Error("hosted-mode storage missing tenant store");
  }
  return ctx.storage.tenants;
}

describe("bearer middleware role projection (OAuth)", () => {
  it("projects users.role 'admin' onto the OAuth principal — /keys CRUD succeeds", async () => {
    const tenant = await tenants().create("admin-tenant");
    const { token } = await seedOauthBearer(
      ctx.storage,
      // No data-plane scopes needed — /keys is gated on role, not scopes.
      [],
      { tenantId: tenant.id, userRole: "admin" },
    );

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    expect(res.status).toBe(200);
  });

  it("projects users.role 'tenant_admin' onto the OAuth principal — /keys CRUD succeeds (tenant-scoped)", async () => {
    const tenant = await tenants().create("tenant-admin-tenant");
    const { token } = await seedOauthBearer(ctx.storage, [], {
      tenantId: tenant.id,
      userRole: "tenant_admin",
    });

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    expect(res.status).toBe(200);
  });

  it("projects users.role 'member' onto the OAuth principal — /keys CRUD forbidden", async () => {
    const tenant = await tenants().create("member-tenant");
    const { token } = await seedOauthBearer(ctx.storage, [], {
      tenantId: tenant.id,
      userRole: "member",
    });

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    // Authenticated but insufficient role → 403, not 401. The gate is
    // gradient: admin/tenant_admin pass, member fails.
    expect(res.status).toBe(403);
  });

  it("falls back to 'member' when no users row exists for the auth_user — /keys CRUD forbidden", async () => {
    // No userRole opt → no users row is seeded. The bearer middleware's
    // role-projection lookup misses and falls back to `member`.
    const { token } = await seedOauthBearer(ctx.storage, []);

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    expect(res.status).toBe(403);
  });

  it("preserves the is_platform: false ceiling — admin OAuth principal cannot mint platform credentials", async () => {
    const tenant = await tenants().create("platform-ceiling-tenant");
    const { token } = await seedOauthBearer(ctx.storage, [], {
      tenantId: tenant.id,
      userRole: "admin",
    });

    // POST /keys with is_platform: true — the route accepts the role gate
    // (admin passes requireTenantAdmin), but `is_platform` is coerced
    // to `false` because the caller is OAuth-authenticated, not an API
    // key with `is_platform: true`. (See routes/keys.ts:337-343.)
    const res = await request(ctx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "should-not-be-platform",
        source: "test-role-projection",
        role: "member",
        is_platform: true,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { is_platform: boolean };
    expect(body.is_platform).toBe(false);
  });
});
