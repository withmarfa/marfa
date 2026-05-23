/**
 * Cross-tenant safety belt for the OAuth bootstrap start route.
 *
 * T-235 threads the connection's `tenant_id` into the credential
 * lookup inside `readAuthorizeConfig`. Pre-T-235 the helper called
 * `storage.items.get(credentialRef)` with no tenant fence — if a
 * connection in tenant A ever ended up with a `credential_ref`
 * pointing at a credential in tenant B (a future bypass of the
 * install pipeline's same-tenant validation), the start route would
 * decrypt tenant-B's `oauth_client_id` and embed it in the
 * authorize URL it returned to the caller. The fix tenant-fences
 * the lookup so cross-tenant references resolve to null and the
 * route returns OAUTH_PROXY_UPSTREAM_INVALID instead.
 *
 * The route's own connection lookup is unfenced by design (only
 * admin / platform callers reach it), so this test seeds the
 * cross-tenant shape through the storage layer and calls the route
 * as the platform admin.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { encryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    oauthRedirectAllowlist: ["http://localhost:0/callback"],
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /connections/:id/oauth/start — cross-tenant credential guard (T-235)", () => {
  it("refuses to resolve a cross-tenant credential_ref even for a platform admin caller", async () => {
    if (!ctx.storage.tenants) return;
    const tenantA = await ctx.storage.tenants.create("t235-oauth-start-A");
    const tenantB = await ctx.storage.tenants.create("t235-oauth-start-B");

    // Credential lives in tenant B. Carries a distinctive client_id
    // so a regression (leak) would surface as the wrong-tenant
    // identifier appearing in the returned authorize URL.
    const crossCred = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "tenant-B-google",
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: "https://accounts.test/oauth/authorize",
            oauth_token_url: "https://accounts.test/oauth/token",
            oauth_client_id: "TENANT-B-CLIENT-DO-NOT-LEAK",
            oauth_default_scope: "openid",
          },
          secret_encrypted: encryptSecret(
            "tenant-b-secret",
            SECRET_INFO.connectionOauthToken,
          ),
        },
      },
      tenantB.id,
    );

    // Connection lives in tenant A, pointing at tenant-B's credential.
    // Built through storage to bypass the install pipeline (which
    // would normally reject this shape) — this IS the scenario the
    // belt guards against.
    const crossConn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: "acme.demo",
          credential_ref: crossCred.id,
        },
      },
      tenantA.id,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${crossConn.id}/oauth/start`,
      {
        key: ctx.adminKey, // platform admin — the only role that can reach this route
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );

    // Fence holds: credential lookup misses (tenant A scope, cred in
    // B), readAuthorizeConfig throws OAUTH_PROXY_UPSTREAM_INVALID.
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oauth_proxy_upstream_invalid");
  });

  it("same-tenant credential_ref resolves cleanly (control case)", async () => {
    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("t235-oauth-start-control");

    const cred = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "same-tenant-google",
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: "https://accounts.test/oauth/authorize",
            oauth_token_url: "https://accounts.test/oauth/token",
            oauth_client_id: "SAME-TENANT-CLIENT",
            oauth_default_scope: "openid",
          },
          secret_encrypted: encryptSecret(
            "same-tenant-secret",
            SECRET_INFO.connectionOauthToken,
          ),
        },
      },
      tenant.id,
    );
    const conn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: "acme.demo",
          credential_ref: cred.id,
        },
      },
      tenant.id,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${conn.id}/oauth/start`,
      {
        key: ctx.adminKey,
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorize_url: string };
    expect(body.authorize_url).toContain("client_id=SAME-TENANT-CLIENT");
  });
});
