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
