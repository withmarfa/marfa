/**
 * Tests for the OAuth bootstrap routes — POST /connections/:id/oauth/start
 * + GET /oauth/callback/:provider.
 *
 * Approach: createTestContext spins up the full app with an in-memory
 * SQLite store. We seed a system.credential (kind: oauth_token) with
 * the provider config + an encrypted client_secret, plus a
 * system.connection that references it via credential_ref. The
 * upstream token endpoint is mocked by stubbing globalThis.fetch (same
 * pattern as connection-proxy.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { encryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";
import { signOAuthState } from "../oauth/state.js";

let ctx: TestContext;
let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
  ctx = await createTestContext();
  realFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  ctx.cleanup();
});

beforeEach(() => {
  globalThis.fetch = realFetch;
});

interface ItemResponse {
  item: { id: string; type: string };
}

async function createCredential(): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.credential",
      properties: {
        kind: "oauth_token",
        label: "google-calendar OAuth credential",
        oauth_provider_config: {
          oauth_authorize_url: "https://accounts.google.test/o/oauth2/v2/auth",
          oauth_token_url: "https://oauth2.google.test/token",
          oauth_client_id: "client_abc.apps.googleusercontent.com",
          oauth_default_scope:
            "https://www.googleapis.com/auth/calendar.events",
        },
        secret_encrypted: encryptSecret(
          "client_secret_xyz",
          SECRET_INFO.connectionOauthToken,
        ),
      },
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

async function createConnection(credentialId: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.connection",
      properties: {
        kind: "external-service-connector",
        status: "active",
        granted_at: new Date().toISOString(),
        credential_ref: credentialId,
        configuration: {},
      },
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

describe("POST /connections/:id/oauth/start", () => {
  it("returns the authorize URL with signed state and the configured scope", async () => {
    const credId = await createCredential();
    const connId = await createConnection(credId);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connId}/oauth/start`,
      {
        key: ctx.adminKey,
        body: {
          redirect_uri: "http://atlas.myme.so:8602/oauth/callback/google",
          extra_params: { access_type: "offline", prompt: "consent" },
        },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorize_url: string;
      connection_id: string;
      expires_in_seconds: number;
    };
    expect(body.connection_id).toBe(connId);
    expect(body.expires_in_seconds).toBeGreaterThan(0);
    const url = new URL(body.authorize_url);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.test/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(
      "client_abc.apps.googleusercontent.com",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://atlas.myme.so:8602/oauth/callback/google",
    );
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.events",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("rejects callers without admin / platform credential", async () => {
    const credId = await createCredential();
    const connId = await createConnection(credId);

    // Mint a member-role key (no platform flag)
    const memberRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "oauth-test-member",
        source: "oauth-test-member",
        role: "member",
      },
    });
    expect(memberRes.status).toBe(201);
    const memberKey = ((await memberRes.json()) as { key: string }).key;

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connId}/oauth/start`,
      {
        key: memberKey,
        body: { redirect_uri: "http://x/" },
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects when redirect_uri is missing", async () => {
    const credId = await createCredential();
    const connId = await createConnection(credId);
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connId}/oauth/start`,
      { key: ctx.adminKey, body: {} },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the connection doesn't exist", async () => {
    const res = await request(
      ctx.app,
      "POST",
      `/connections/conn_does_not_exist/oauth/start`,
      {
        key: ctx.adminKey,
        body: { redirect_uri: "http://x/" },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 422 when the connection's credential is missing OAuth provider config", async () => {
    // Credential without oauth_provider_config — start should refuse.
    const credRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.credential",
        properties: { kind: "api_key", label: "wrong kind" },
      },
    });
    const badCredId = ((await credRes.json()) as ItemResponse).item.id;
    const connId = await createConnection(badCredId);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connId}/oauth/start`,
      {
        key: ctx.adminKey,
        body: { redirect_uri: "http://x/" },
      },
    );
    expect(res.status).toBe(422);
  });
});

describe("GET /oauth/callback/:provider", () => {
  it("exchanges the code, persists tokens, returns success HTML", async () => {
    const credId = await createCredential();
    const connId = await createConnection(credId);

    const tokenCalls: { url: string; body: string }[] = [];
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      tokenCalls.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        body:
          typeof init?.body === "string"
            ? init.body
            : ((init?.body as URLSearchParams | undefined)?.toString() ?? ""),
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "ya29.access_test",
            refresh_token: "1//refresh_test",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/calendar.events",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const state = signOAuthState({
      connection_id: connId,
      redirect_uri: "http://atlas.myme.so:8602/oauth/callback/google",
    });
    const res = await request(
      ctx.app,
      "GET",
      `/oauth/callback/google?code=auth_code_xyz&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authorisation complete");
    expect(html).toContain(connId);
    // §3.18: success page carries no-store headers.
    expect(res.headers.get("cache-control")).toBe(
      "no-store, no-cache, private",
    );
    expect(res.headers.get("pragma")).toBe("no-cache");

    // Token endpoint hit with the right shape
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.url).toBe("https://oauth2.google.test/token");
    expect(tokenCalls[0]!.body).toContain("grant_type=authorization_code");
    expect(tokenCalls[0]!.body).toContain("code=auth_code_xyz");
    expect(tokenCalls[0]!.body).toContain(
      "redirect_uri=http%3A%2F%2Fatlas.myme.so%3A8602%2Foauth%2Fcallback%2Fgoogle",
    );

    // Tokens persisted in connectionOauthTokens
    const row = await ctx.storage.connectionOauthTokens.get(connId);
    expect(row).not.toBeNull();
    expect(row?.scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    // Both access + refresh stored encrypted (we don't decrypt here —
    // the proxy's existing test covers the round-trip).
    expect(row?.access_token_encrypted.length).toBeGreaterThan(0);
    expect(row?.refresh_token_encrypted?.length).toBeGreaterThan(0);
  });

  it("returns 400 with error HTML when state is missing", async () => {
    const res = await request(ctx.app, "GET", `/oauth/callback/google?code=x`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/Missing code or state/);
  });

  it("returns 400 with error HTML when state is tampered", async () => {
    const credId = await createCredential();
    const connId = await createConnection(credId);
    const state = signOAuthState({
      connection_id: connId,
      redirect_uri: "http://x/",
    });
    const tampered = state.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const res = await request(
      ctx.app,
      "GET",
      `/oauth/callback/google?code=x&state=${encodeURIComponent(tampered)}`,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/State validation failed/);
  });

  it("returns 400 with provider-error message when ?error= is set", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/oauth/callback/google?error=access_denied&error_description=user_declined`,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/access_denied/);
    expect(html).toMatch(/user_declined/);
  });

  it("returns 502 when the upstream token endpoint returns an error", async () => {
    const credId = await createCredential();
    const connId = await createConnection(credId);
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("invalid_grant", { status: 400 }),
      )) as typeof fetch;
    const state = signOAuthState({
      connection_id: connId,
      redirect_uri: "http://x/",
    });
    const res = await request(
      ctx.app,
      "GET",
      `/oauth/callback/google?code=bad&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toMatch(/Upstream returned 400/);
  });

  it("returns 404 with error HTML when the state's connection has been deleted", async () => {
    const credId = await createCredential();
    const connId = await createConnection(credId);
    const state = signOAuthState({
      connection_id: connId,
      redirect_uri: "http://x/",
    });
    // Delete the connection between start + callback
    const delRes = await request(ctx.app, "DELETE", `/items/${connId}`, {
      key: ctx.adminKey,
    });
    expect([200, 204]).toContain(delRes.status);
    // Now hard-purge so the lookup actually returns null
    await request(ctx.app, "DELETE", `/items/${connId}`, {
      key: ctx.adminKey,
    });
    const res = await request(
      ctx.app,
      "GET",
      `/oauth/callback/google?code=x&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(404);
  });
});
