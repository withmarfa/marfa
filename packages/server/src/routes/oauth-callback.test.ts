/**
 * Cross-space safety belt for the OAuth bootstrap start route.
 *
 * The credential lookup inside `readAuthorizeConfig` is fenced by the
 * connection's `space_id`. Without this fence, if a connection in space
 * A held a `credential_ref` pointing at a credential in space B, the start
 * route would decrypt space B's `oauth_client_id` and embed it in the
 * authorize URL. The fence ensures cross-space references resolve to null
 * and the route returns OAUTH_PROXY_UPSTREAM_INVALID instead.
 *
 * The route's own connection lookup is unfenced by design (only admin /
 * platform callers reach it), so this test seeds the cross-space shape
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

describe("POST /connections/:id/oauth/start — cross-space credential guard", () => {
  it("refuses to resolve a cross-space credential_ref even for a platform admin caller", async () => {
    if (!ctx.storage.spaces) return;
    const spaceA = await ctx.storage.spaces.create("t235-oauth-start-A");
    const spaceB = await ctx.storage.spaces.create("t235-oauth-start-B");

    // Credential lives in space B. Carries a distinctive client_id
    // so a regression (leak) would surface as the wrong-space
    // identifier appearing in the returned authorize URL.
    const crossCred = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "space-B-google",
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: "https://accounts.test/oauth/authorize",
            oauth_token_url: "https://accounts.test/oauth/token",
            oauth_client_id: "SPACE-B-CLIENT-DO-NOT-LEAK",
            oauth_default_scope: "openid",
          },
          secret_encrypted: encryptSecret(
            "space-b-secret",
            SECRET_INFO.connectionOauthToken,
          ),
        },
      },
      spaceB.id,
    );

    // Connection lives in space A, pointing at space-B's credential.
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
      spaceA.id,
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

    // Fence holds: credential lookup misses (space A scope, cred in
    // B), readAuthorizeConfig throws OAUTH_PROXY_UPSTREAM_INVALID.
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oauth_proxy_upstream_invalid");
  });

  it("same-space credential_ref resolves cleanly (control case)", async () => {
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("t235-oauth-start-control");

    const cred = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "same-space-google",
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: "https://accounts.test/oauth/authorize",
            oauth_token_url: "https://accounts.test/oauth/token",
            oauth_client_id: "SAME-SPACE-CLIENT",
            oauth_default_scope: "openid",
          },
          secret_encrypted: encryptSecret(
            "same-space-secret",
            SECRET_INFO.connectionOauthToken,
          ),
        },
      },
      space.id,
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
      space.id,
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
    expect(body.authorize_url).toContain("client_id=SAME-SPACE-CLIENT");
  });
});

describe("POST /connections/:id/oauth/start — credential authorize_extra_params", () => {
  async function seedConnection(opts: {
    space_label: string;
    authorize_extra_params?: Record<string, string>;
  }): Promise<string> {
    if (!ctx.storage.spaces) throw new Error("spaces store required");
    const space = await ctx.storage.spaces.create(opts.space_label);
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
      space.id,
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
      space.id,
    );
    return conn.id;
  }

  it("merges credential.authorize_extra_params into the authorize URL when caller passes no extra_params", async () => {
    const connId = await seedConnection({
      space_label: "t259-merge-defaults",
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
      space_label: "t259-caller-overrides",
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
      space_label: "t259-no-defaults",
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
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("t259-malformed");
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
      space.id,
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
      space.id,
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

describe("POST /connections/:id/oauth/start — redirect allowlist fail-closed", () => {
  // Each case spins up its own context with a specific authMode +
  // oauthRedirectAllowlist, since these are app-construction-time config and
  // can't be varied per-request. Seeds one valid connection per context.
  async function seedConnection(c: TestContext): Promise<string> {
    if (!c.storage.spaces) throw new Error("spaces store required");
    const space = await c.storage.spaces.create(
      `redirect-allowlist-${Math.random().toString(36).slice(2, 10)}`,
    );
    const cred = await c.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "google",
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: "https://accounts.test/oauth/authorize",
            oauth_token_url: "https://accounts.test/oauth/token",
            oauth_client_id: "CLIENT",
            oauth_default_scope: "openid",
          },
          secret_encrypted: encryptSecret(
            "secret",
            SECRET_INFO.connectionOauthToken,
          ),
        },
      },
      space.id,
    );
    const conn = await c.storage.items.create(
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
      space.id,
    );
    return conn.id;
  }

  it("rejects every redirect_uri when the allowlist is empty in hosted mode (fail closed)", async () => {
    const hostedCtx = await createTestContext({
      authMode: "hosted",
      oauthRedirectAllowlist: [],
      mcpEnabled: false,
    });
    try {
      if (!hostedCtx.storage.spaces) return; // hosted requires the space store
      const connId = await seedConnection(hostedCtx);
      const res = await request(
        hostedCtx.app,
        "POST",
        `/connections/${connId}/oauth/start`,
        {
          key: hostedCtx.adminKey,
          body: { redirect_uri: "https://attacker.example/callback" },
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_error");
    } finally {
      await hostedCtx.cleanup();
    }
  });

  it("allows any redirect_uri when the allowlist is empty in keys mode (passthrough preserved)", async () => {
    const keysCtx = await createTestContext({
      authMode: "keys",
      oauthRedirectAllowlist: [],
      mcpEnabled: false,
    });
    try {
      if (!keysCtx.storage.spaces) return;
      const connId = await seedConnection(keysCtx);
      const res = await request(
        keysCtx.app,
        "POST",
        `/connections/${connId}/oauth/start`,
        {
          key: keysCtx.adminKey,
          body: { redirect_uri: "https://anything.example/callback" },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authorize_url: string };
      expect(body.authorize_url).toContain(
        "redirect_uri=https%3A%2F%2Fanything.example%2Fcallback",
      );
    } finally {
      await keysCtx.cleanup();
    }
  });

  it("with a non-empty allowlist, only listed redirect URIs are allowed (both modes)", async () => {
    const hostedCtx = await createTestContext({
      authMode: "hosted",
      oauthRedirectAllowlist: ["https://app.example/callback"],
    });
    try {
      if (!hostedCtx.storage.spaces) return;
      const connId = await seedConnection(hostedCtx);

      // Listed URI passes.
      const allowed = await request(
        hostedCtx.app,
        "POST",
        `/connections/${connId}/oauth/start`,
        {
          key: hostedCtx.adminKey,
          body: { redirect_uri: "https://app.example/callback" },
        },
      );
      expect(allowed.status).toBe(200);

      // Unlisted URI rejected.
      const rejected = await request(
        hostedCtx.app,
        "POST",
        `/connections/${connId}/oauth/start`,
        {
          key: hostedCtx.adminKey,
          body: { redirect_uri: "https://other.example/callback" },
        },
      );
      expect(rejected.status).toBe(400);
      const body = (await rejected.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_error");
    } finally {
      await hostedCtx.cleanup();
    }
  });
});
