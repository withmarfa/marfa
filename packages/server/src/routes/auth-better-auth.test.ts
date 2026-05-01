import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Smoke tests for the better-auth integration mounted at /auth/*.
 *
 * Coverage:
 *   - sign-up enabled vs disabled gating (MYME_AUTH_ALLOW_SIGNUP)
 *   - sign-in with email + password
 *   - session cookie is HttpOnly + Secure + SameSite=Lax + path=/auth
 *   - session cookie does NOT authenticate API calls (the data plane
 *     remains bearer-only — `/items` returns 401 with only the cookie)
 */

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

// Better-auth performs an Origin / trustedOrigins check on every request.
// In-process tests don't supply a real Origin, so we set one matching the
// test config's authBaseUrl.
const ORIGIN = "http://localhost:0";

async function signUp(
  c: TestContext,
  email: string,
  password: string,
  name = "Test User",
): Promise<Response> {
  return request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name },
    headers: { origin: ORIGIN },
  });
}

async function signIn(
  c: TestContext,
  email: string,
  password: string,
): Promise<Response> {
  return request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
}

describe("better-auth /auth/* surface", () => {
  it("allows email + password sign-up when MYME_AUTH_ALLOW_SIGNUP=true", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await signUp(ctx, "alice@example.com", "correct horse battery");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email?: string } };
    expect(body.user?.email).toBe("alice@example.com");
  });

  it("rejects email + password sign-up when MYME_AUTH_ALLOW_SIGNUP=false", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await signUp(ctx, "bob@example.com", "correct horse battery");
    // better-auth returns 403 when sign-up is disabled.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("authenticates an existing user via sign-in/email", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const signUpRes = await signUp(
      ctx,
      "carol@example.com",
      "correct horse battery",
    );
    if (signUpRes.status !== 200) {
      const text = await signUpRes.text();
      throw new Error(
        `sign-up/email returned ${String(signUpRes.status)}: ${text.slice(0, 600)}`,
      );
    }

    const res = await signIn(ctx, "carol@example.com", "correct horse battery");
    if (res.status !== 200) {
      // Surface body to diagnose if this regresses.
      const text = await res.text();
      throw new Error(
        `sign-in/email returned ${String(res.status)}: ${text.slice(0, 400)}`,
      );
    }
    const cookieHeader = res.headers.get("set-cookie");
    expect(cookieHeader).toBeTruthy();
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
    // Test config uses http://localhost:0 — Secure must be OFF on HTTP
    // baseURL or Chrome silently drops the cookie (regression guard).
    expect(cookieHeader).not.toMatch(/Secure/i);
  });

  it("session cookie includes Secure when baseURL is HTTPS", async () => {
    // Regression guard: under an HTTPS baseURL, the cookie attributes
    // MUST include Secure so the cookie isn't sent over HTTP.
    const HTTPS_ORIGIN = "https://example.test";
    ctx = await createTestContext({
      authAllowSignup: true,
      authBaseUrl: HTTPS_ORIGIN,
    });
    // Use the matching origin since baseURL drives trustedOrigins.
    const signUpRes = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "secure-cookie-test@example.com",
        password: "correct horse battery",
        name: "Test",
      },
      headers: { origin: HTTPS_ORIGIN },
    });
    if (signUpRes.status !== 200) {
      const text = await signUpRes.text();
      throw new Error(
        `sign-up/email returned ${String(signUpRes.status)}: ${text.slice(0, 400)}`,
      );
    }
    const res = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: {
        email: "secure-cookie-test@example.com",
        password: "correct horse battery",
      },
      headers: { origin: HTTPS_ORIGIN },
    });
    if (res.status !== 200) {
      const text = await res.text();
      throw new Error(
        `sign-in/email returned ${String(res.status)}: ${text.slice(0, 400)}`,
      );
    }
    const cookieHeader = res.headers.get("set-cookie");
    expect(cookieHeader).toBeTruthy();
    expect(cookieHeader).toMatch(/Secure/i);
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
  });

  it("rejects a wrong password with 4xx", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUp(ctx, "dave@example.com", "correct horse battery");

    const res = await signIn(ctx, "dave@example.com", "wrong");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("session cookie does NOT authenticate /items — data plane stays bearer-only", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const signUpRes = await signUp(
      ctx,
      "eve@example.com",
      "correct horse battery",
    );
    const setCookie = signUpRes.headers.get("set-cookie");
    // Send the cookie back without any Bearer token. /items should 401.
    const res = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: setCookie ? { cookie: setCookie } : {},
    });
    expect(res.status).toBe(401);
  });

  it("returns the active session via /auth/get-session for a signed-in user", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const signUpRes = await signUp(
      ctx,
      "frank@example.com",
      "correct horse battery",
    );
    const setCookie = signUpRes.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0];

    const res = await request(ctx.app, "GET", "/auth/get-session", {
      headers: cookie ? { cookie } : {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user?: { email?: string };
      session?: unknown;
    } | null;
    expect(body?.user?.email).toBe("frank@example.com");
  });

  it("magic-link request creates a verification token (default log transport)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // First sign up so the user exists.
    await signUp(ctx, "grace@example.com", "correct horse battery");
    const res = await request(ctx.app, "POST", "/auth/sign-in/magic-link", {
      body: {
        email: "grace@example.com",
        callbackURL: "http://localhost:0/callback",
      },
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: boolean };
    expect(body.status).toBe(true);
  });

  it("exposes passkey registration challenge under /auth/passkey/*", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const signUpRes = await signUp(
      ctx,
      "henry@example.com",
      "correct horse battery",
    );
    const cookie = signUpRes.headers.get("set-cookie")?.split(";")[0];

    // Generating a registration challenge is a GET requiring a fresh session.
    const res = await request(
      ctx.app,
      "GET",
      "/auth/passkey/generate-register-options",
      {
        headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
      },
    );
    // Either a 200 with challenge or a 4xx — we just verify the route is
    // mounted (not a 404 falling through to a different handler).
    expect(res.status).not.toBe(404);
  });

  it("federated OIDC provider exposes /auth/sign-in/oauth2 when configured", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      oidcProviders: [
        {
          providerId: "test-provider",
          clientId: "test-client",
          clientSecret: "test-secret",
          discoveryUrl:
            "https://accounts.example.com/.well-known/openid-configuration",
        },
      ],
    });

    // The endpoint is mounted; we just verify it isn't 404 (it'll fail
    // to fetch the discovery URL in the test, but the route exists).
    const res = await request(ctx.app, "POST", "/auth/sign-in/oauth2", {
      body: { providerId: "test-provider" },
      headers: { origin: ORIGIN },
    });
    expect(res.status).not.toBe(404);
  });

  it("genericOAuth gracefully skips when no providers configured", async () => {
    ctx = await createTestContext({ authAllowSignup: true, oidcProviders: [] });
    // /auth/sign-in/oauth2 still mounted (the plugin registers regardless),
    // but errors out for an unknown providerId. Just confirming no crash.
    const res = await request(ctx.app, "POST", "/auth/sign-in/oauth2", {
      body: { providerId: "nope" },
      headers: { origin: ORIGIN },
    });
    expect(res.status).not.toBe(500);
  });

  it("/.well-known/oauth-authorization-server returns the discovery doc", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-authorization-server",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
    expect(body.issuer).toBeTruthy();
    expect(body.authorization_endpoint).toMatch(/\/auth\/authorize$/);
    expect(body.token_endpoint).toMatch(/\/auth\/token$/);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("/auth/grants returns user-app-grant connections, /auth/grants/{id} revokes", async () => {
    ctx = await createTestContext({ authAllowSignup: false });

    // Create an OAuth client and a grant via the storage layer (the public
    // surface for client registration is admin-only and exercised elsewhere).
    const client = await ctx.storage.oauth.createClient({
      name: "Test App",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    const grant = await ctx.storage.oauth.createGrant(client.id, [
      "core.note:read",
    ]);

    const listRes = await request(ctx.app, "GET", "/auth/grants", {
      key: ctx.adminKey,
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      id: string;
      client_id: string;
      scopes: string[];
      status: string;
    }[];
    expect(list.some((g) => g.id === grant.id)).toBe(true);
    const found = list.find((g) => g.id === grant.id);
    expect(found?.client_id).toBe(client.id);
    expect(found?.scopes).toEqual(["core.note:read"]);
    expect(found?.status).toBe("active");

    // Revoke
    const revokeRes = await request(
      ctx.app,
      "DELETE",
      `/auth/grants/${grant.id}`,
      { key: ctx.adminKey },
    );
    expect(revokeRes.status).toBe(204);

    // Confirm it's gone from the active list
    const list2Res = await request(ctx.app, "GET", "/auth/grants", {
      key: ctx.adminKey,
    });
    const list2 = (await list2Res.json()) as { id: string }[];
    expect(list2.some((g) => g.id === grant.id)).toBe(false);
  });

  it("does NOT shadow the existing /auth/clients route", async () => {
    // Existing oauth client management lives at /auth/clients (admin-only).
    // The better-auth catch-all is registered AFTER it, so explicit routes
    // win — confirm we still get the legacy 401 (no auth) shape, not a
    // better-auth 404 / generic body.
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await request(ctx.app, "GET", "/auth/clients");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unauthorized");
  });
});
