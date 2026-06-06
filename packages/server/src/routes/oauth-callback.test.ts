/**
 * Cross-tenant safety belt for the OAuth bootstrap start route.
 *
 * The credential lookup inside `readAuthorizeConfig` is fenced by the
 * connection's `tenant_id`. Without this fence, if a connection in tenant
 * A held a `credential_ref` pointing at a credential in tenant B, the start
 * route would decrypt tenant B's `oauth_client_id` and embed it in the
 * authorize URL. The fence ensures cross-tenant references resolve to null
 * and the route returns OAUTH_PROXY_UPSTREAM_INVALID instead.
 *
 * The route's own connection lookup is unfenced by design (only admin /
 * platform callers reach it), so this test seeds the cross-tenant shape
 * through the storage layer and calls the route as the platform admin.
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

describe("POST /connections/:id/oauth/start — cross-tenant credential guard", () => {
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

describe("POST /connections/:id/oauth/start — credential authorize_extra_params", () => {
  async function seedConnection(opts: {
    tenant_label: string;
    authorize_extra_params?: Record<string, string>;
  }): Promise<string> {
    if (!ctx.storage.tenants) throw new Error("tenants store required");
    const tenant = await ctx.storage.tenants.create(opts.tenant_label);
    const cred = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "google-shared",
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
            oauth_token_url: "https://oauth2.googleapis.com/token",
            oauth_client_id: "GOOGLE-CLIENT",
            oauth_default_scope: "openid",
            ...(opts.authorize_extra_params
              ? { authorize_extra_params: opts.authorize_extra_params }
              : {}),
          },
          secret_encrypted: encryptSecret(
            "google-client-secret",
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
          integration_ref: "google.calendar",
          credential_ref: cred.id,
        },
      },
      tenant.id,
    );
    return conn.id;
  }

  it("merges credential.authorize_extra_params into the authorize URL when caller passes no extra_params", async () => {
    const connId = await seedConnection({
      tenant_label: "t259-merge-defaults",
      authorize_extra_params: {
        access_type: "offline",
        prompt: "consent",
      },
    });
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connId}/oauth/start`,
      {
        key: ctx.adminKey,
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorize_url: string };
    expect(body.authorize_url).toContain("access_type=offline");
    expect(body.authorize_url).toContain("prompt=consent");
  });

  it("caller's extra_params overrides credential defaults per-key", async () => {
    const connId = await seedConnection({
      tenant_label: "t259-caller-overrides",
      authorize_extra_params: {
        access_type: "offline",
        prompt: "consent",
      },
    });
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connId}/oauth/start`,
      {
        key: ctx.adminKey,
        body: {
          redirect_uri: "http://localhost:0/callback",
          // Override `prompt`; leave `access_type` to the credential default.
          extra_params: { prompt: "none" },
        },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorize_url: string };
    expect(body.authorize_url).toContain("access_type=offline"); // from credential
    expect(body.authorize_url).toContain("prompt=none"); // caller wins
    expect(body.authorize_url).not.toContain("prompt=consent");
  });

  it("absent authorize_extra_params on the credential leaves the URL clean", async () => {
    const connId = await seedConnection({
      tenant_label: "t259-no-defaults",
    });
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connId}/oauth/start`,
      {
        key: ctx.adminKey,
        body: { redirect_uri: "http://localhost:0/callback" },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorize_url: string };
    expect(body.authorize_url).not.toContain("access_type=");
    expect(body.authorize_url).not.toContain("prompt=");
  });

  it("malformed authorize_extra_params on the credential is ignored (not echoed verbatim)", async () => {
    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("t259-malformed");
    const cred = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "google-shared",
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
            oauth_token_url: "https://oauth2.googleapis.com/token",
            oauth_client_id: "GOOGLE-CLIENT",
            // Mixed types — only string values survive the filter.
            authorize_extra_params: {
              access_type: "offline",
              valid_int_as_string: "1",
              bad: 42 as unknown as string,
              array_value: ["nope"] as unknown as string,
            },
          },
          secret_encrypted: encryptSecret(
            "google-client-secret",
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
          integration_ref: "google.calendar",
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
    expect(body.authorize_url).toContain("access_type=offline");
    expect(body.authorize_url).toContain("valid_int_as_string=1");
    expect(body.authorize_url).not.toContain("bad=");
    expect(body.authorize_url).not.toContain("array_value=");
  });
});
