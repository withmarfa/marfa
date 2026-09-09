/**
 * The integration OAuth bootstrap: what reaches the upstream provider.
 *
 * Two properties, kept in one file because they are the same property seen
 * from different sides. The credential a connection resolves must be its
 * own space's, and the redirect URI must be this server's own rather than
 * anything a caller supplied.
 *
 * Cross-space safety belt for the start route.
 *
 * The credential lookup inside `readAuthorizeConfig` is fenced by the
 * connection's `space_id`. Without this fence, if a connection in space
 * A held a `credential_ref` pointing at a credential in space B, the start
 * route would decrypt space B's `oauth_client_id` and embed it in the
 * authorize URL. The fence ensures cross-space references resolve to null
 * and the route returns OAUTH_PROXY_UPSTREAM_INVALID instead.
 *
 * The route's own connection lookup passes the caller's `space_id`, so it is
 * already fenced for any credential bound to a space; the door itself is
 * `space.credentials`. This test calls it with the operator key, which is
 * bound to no space at all, so that lookup narrows nothing and the
 * cross-space shape reaches the credential fence this file is about. The
 * shape is seeded through the storage layer because the install pipeline
 * would refuse it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { encryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";
import { verifyOAuthState } from "../oauth/state.js";
import { deriveOAuthCallbackUri } from "./oauth-callback.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /connections/:id/oauth/start — cross-space credential guard", () => {
  it("refuses to resolve a cross-space credential_ref even for the operator key", async () => {
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
        // Bound to no space, so the route's own lookup narrows nothing. The
        // door is `space.credentials`, which this key holds.
        key: ctx.adminKey,
        body: {},
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
        body: {},
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
        body: {},
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
        body: {},
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
        body: {},
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

// ---------------------------------------------------------------------------
// The redirect URI is the server's own, and nothing a caller sends can
// change it.
// ---------------------------------------------------------------------------

describe("POST /connections/:id/oauth/start — the redirect URI is derived", () => {
  async function seedConnection(): Promise<string> {
    const cred = await ctx.storage.items.create({
      type: "system.credential",
      properties: {
        label: "Acme",
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
    });
    const conn = await ctx.storage.items.create({
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: "acme.demo",
        credential_ref: cred.id,
      },
    });
    return conn.id;
  }

  async function start(
    connId: string,
    body: Record<string, unknown>,
  ): Promise<{ authorize_url: string; redirect_uri: string }> {
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connId}/oauth/start`,
      { key: ctx.adminKey, body },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      authorize_url: string;
      redirect_uri: string;
    };
  }

  it("sends this deployment's own callback, with no redirect_uri supplied", async () => {
    // The whole point: a request carrying nothing about where to come back
    // to still produces a complete authorize URL. Before this, the same
    // request was a 400 asking for a value only one setting of which could
    // ever have been right.
    const body = await start(await seedConnection(), {});
    expect(body.redirect_uri).toBe("http://localhost:0/oauth/callback");
    expect(new URL(body.authorize_url).searchParams.get("redirect_uri")).toBe(
      "http://localhost:0/oauth/callback",
    );
  });

  it("ignores a redirect_uri a caller sends anyway", async () => {
    const body = await start(await seedConnection(), {
      redirect_uri: "https://attacker.example/callback",
    });
    expect(body.authorize_url).not.toContain("attacker.example");
    expect(new URL(body.authorize_url).searchParams.get("redirect_uri")).toBe(
      "http://localhost:0/oauth/callback",
    );
  });

  it("does not let extra_params overwrite the redirect URI", async () => {
    // This is the one that mattered. `extra_params` was applied to the
    // parameter map AFTER redirect_uri was set and after the allowlist had
    // passed, so a caller could name the key directly and send the
    // authorization code wherever it liked — walking straight past the
    // control written to stop exactly that.
    const body = await start(await seedConnection(), {
      extra_params: {
        redirect_uri: "https://attacker.example/callback",
        access_type: "offline",
      },
    });
    const params = new URL(body.authorize_url).searchParams;
    expect(params.get("redirect_uri")).toBe(
      "http://localhost:0/oauth/callback",
    );
    expect(params.getAll("redirect_uri")).toHaveLength(1);
    // The benign key still lands, so this is a fence rather than a ban.
    expect(params.get("access_type")).toBe("offline");
  });

  it("does not let extra_params overwrite the other protocol parameters", async () => {
    const body = await start(await seedConnection(), {
      extra_params: {
        client_id: "SUBSTITUTE",
        state: "forged",
        code_challenge: "forged",
        code_challenge_method: "plain",
        response_type: "token",
      },
    });
    const params = new URL(body.authorize_url).searchParams;
    expect(params.get("client_id")).toBe("CLIENT");
    expect(params.get("state")).not.toBe("forged");
    expect(params.get("code_challenge")).not.toBe("forged");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("response_type")).toBe("code");
  });

  it("signs the derived URI into the state, so the token exchange cannot disagree with the authorize call", async () => {
    const body = await start(await seedConnection(), {});
    const state = new URL(body.authorize_url).searchParams.get("state");
    expect(state).toBeTruthy();
    const verified = verifyOAuthState(state!);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.envelope.redirect_uri).toBe(
      "http://localhost:0/oauth/callback",
    );
    expect(verified.envelope.provider_label).toBe("Acme");
  });
});

describe("GET /oauth/callback", () => {
  it("is served at one fixed path, with no provider segment", async () => {
    const res = await request(ctx.app, "GET", "/oauth/callback");
    // No code and no state, so it refuses — but it refuses as the callback
    // rather than as an unrouted path, which is what pins the mount point.
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing code or state");
  });

  it("no longer answers on the old per-provider path", async () => {
    const res = await request(ctx.app, "GET", "/oauth/callback/google");
    expect(res.status).toBe(404);
  });
});

describe("deriveOAuthCallbackUri", () => {
  it("is the base URL plus the callback path", () => {
    expect(deriveOAuthCallbackUri("https://api.marfa.so")).toBe(
      "https://api.marfa.so/oauth/callback",
    );
  });

  it("does not double the separator when the base carries a trailing slash", () => {
    // A provider compares the redirect URI as a string, so `//oauth/callback`
    // is a different value from the one on file and the flow dies at the
    // provider with an error nothing on this side can explain.
    expect(deriveOAuthCallbackUri("https://api.marfa.so/")).toBe(
      "https://api.marfa.so/oauth/callback",
    );
  });
});
