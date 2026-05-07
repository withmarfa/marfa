import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Wave C PR2 — end-to-end smoke for the verify-on-signup flow:
 *   - sign-up emits no Set-Cookie (requireEmailVerification on)
 *   - sign-up wrapper redirects to /auth/verify-email
 *   - GET /auth/verify-email without token → pending state
 *   - GET /auth/verify-email?sent=1 → resent state
 *   - POST /auth/verify-email/resend → 302 with sent=1
 *   - signing in pre-verification fails; post-verification (markEmailVerified)
 *     succeeds — proves requireEmailVerification is the gate, not just the
 *     wrapper redirect.
 *
 * The token round-trip (clicking the verify link) requires
 * better-auth's signed token; tests exercising that flow stand in
 * via `markEmailVerified` rather than reaching into better-auth's
 * internal token signer.
 */

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

async function postSignUpForm(
  c: TestContext,
  fields: Record<string, string>,
): Promise<Response> {
  return c.app.fetch(
    new Request(`${ORIGIN}/auth/sign-up`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

async function postSignInForm(
  c: TestContext,
  fields: Record<string, string>,
): Promise<Response> {
  return c.app.fetch(
    new Request(`${ORIGIN}/auth/sign-in`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

describe("Wave C PR2: verify-on-signup flow", () => {
  it("sign-up returns 302 to /auth/verify-email with no session cookie", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      username: "alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/auth/authorize?client_id=abc",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/verify-email");
    expect(location).toContain("email=alice%40example.com");
    const cookies =
      typeof (res.headers as Headers & { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (
            res.headers as Headers & { getSetCookie: () => string[] }
          ).getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    expect(cookies.some((c) => c.includes("myme.auth"))).toBe(false);
  });

  it("GET /auth/verify-email without token renders the pending state", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/verify-email?email=alice%40example.com",
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Verify your email");
    expect(html).toContain('value="alice@example.com"');
    expect(html).toContain('action="/auth/verify-email/resend"');
  });

  it("GET /auth/verify-email?sent=1 renders the resent state", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/verify-email?email=alice%40example.com&sent=1",
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("fresh verification email");
    expect(html).toContain('class="banner banner--success"');
  });

  it("POST /auth/verify-email/resend redirects with sent=1", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    // Sign up first so the address is known to better-auth (the
    // soft-fail invariant means it'd 302 either way, but exercising
    // the live address proves the dispatch path).
    await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      username: "alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/verify-email/resend`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          email: "alice@example.com",
          return_to: "/",
        }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/verify-email");
    expect(location).toContain("sent=1");
    expect(location).toContain("email=alice%40example.com");
  });

  it("POST /auth/verify-email/resend with empty email redirects to the bare verify page", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/verify-email/resend`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({ email: "", return_to: "/" }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/verify-email");
    expect(location).not.toContain("sent=1");
  });

  it("POST /auth/verify-email/resend on an unknown address still 302s with sent=1 (no enumeration)", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/verify-email/resend`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          email: "ghost@example.com",
          return_to: "/",
        }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sent=1");
  });

  it("sign-in is blocked pre-verification, succeeds post-verification", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      username: "alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });

    // Pre-verification: better-auth blocks the password sign-in.
    const blocked = await postSignInForm(ctx, {
      mode: "password",
      email: "alice@example.com",
      password: "correct horse",
      return_to: "/",
    });
    expect(blocked.status).toBe(302);
    expect(blocked.headers.get("location")).toContain(
      "error=invalid_credentials",
    );

    // Stand-in for clicking the verification link.
    await markEmailVerified(ctx.storage, "alice@example.com");

    // Post-verification: same credentials → 302 to return_to with cookie.
    const allowed = await postSignInForm(ctx, {
      mode: "password",
      email: "alice@example.com",
      password: "correct horse",
      return_to: "/",
    });
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("location")).toBe("/");
    const cookies =
      typeof (allowed.headers as Headers & { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (
            allowed.headers as Headers & { getSetCookie: () => string[] }
          ).getSetCookie()
        : [allowed.headers.get("set-cookie") ?? ""];
    expect(cookies.some((c) => c.includes("myme.auth"))).toBe(true);
  });

  it("GET /auth/verify-email with bad token renders the failure state", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/verify-email?token=not-a-real-token",
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Verification failed");
    expect(html).toContain('class="banner banner--error"');
  });
});
