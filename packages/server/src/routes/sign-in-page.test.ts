import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { renderSignInPage, validateReturnTo } from "./sign-in-page.js";

/**
 * Smoke tests for GET /auth/sign-in (HTML page) + the POST /auth/sign-in
 * form-handler that wraps Better Auth's JSON API. Coverage:
 *   - 200 + text/html + form action/method correct
 *   - return_to round-trips through the form's hidden field
 *   - mode=magic renders the email-only form
 *   - allowSignup conditionally renders the sign-up link
 *   - oidcProviderIds renders one button per provider
 *   - error/sent query params surface as banners with role=alert/status
 *   - validateReturnTo rejects open-redirect attempts
 *   - POST /auth/sign-in with bad credentials redirects with error code
 */

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("renderSignInPage", () => {
  it("renders both forms with the right action + hidden return_to", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/auth/authorize?client_id=abc",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('<form method="POST" action="/auth/sign-in"');
    expect(html).toContain(
      '<input type="hidden" name="mode" value="password">',
    );
    expect(html).toContain(
      '<input type="hidden" name="return_to" value="/auth/authorize?client_id=abc">',
    );
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
  });

  it("escapes HTML in returnTo to prevent template injection", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: '/foo"><script>alert(1)</script>',
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders email-only form when mode=magic", () => {
    const html = renderSignInPage({
      mode: "magic",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('value="magic"');
    expect(html).toContain('name="email"');
    expect(html).not.toContain('name="password"');
    expect(html).toContain("Send sign-in link");
  });

  it("conditionally renders the sign-up link by allowSignup", () => {
    const withSignup = renderSignInPage({
      mode: "password",
      returnTo: "/",
      allowSignup: true,
      oidcProviderIds: [],
    });
    expect(withSignup).toContain("/auth/sign-up");
    expect(withSignup).toContain("Create one");

    const withoutSignup = renderSignInPage({
      mode: "password",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(withoutSignup).not.toContain("/auth/sign-up");
    expect(withoutSignup).not.toContain("Create one");
  });

  it("renders one OIDC button per configured provider", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: ["google", "github", "authentik"],
    });
    expect(html).toContain('action="/auth/sign-in/provider/google"');
    expect(html).toContain('action="/auth/sign-in/provider/github"');
    expect(html).toContain('action="/auth/sign-in/provider/authentik"');
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("Continue with Authentik");
  });

  it("renders no separator + no oidc block when providers list is empty", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).not.toContain('class="oidc"');
    expect(html).not.toContain('class="separator"');
  });

  it("renders an error banner with role=alert when error is set", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/",
      error: "invalid_credentials",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("That email or password is wrong");
  });

  it("falls back to a generic message for unknown error codes", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/",
      error: "some_unknown_code",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
  });

  it("renders a success banner with role=status when magicLinkSent", () => {
    const html = renderSignInPage({
      mode: "magic",
      returnTo: "/",
      magicLinkSent: true,
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('class="banner banner--success"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Check your email");
  });

  it("renders both tabs with the active one marked aria-selected=true", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/auth/authorize",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('href="/auth/sign-in?mode=password&amp;return_to=');
    expect(html).toContain('href="/auth/sign-in?mode=magic&amp;return_to=');
    // Active tab on password mode
    expect(html).toMatch(
      /mode=password[^"]*"\s+role="tab"\s+aria-selected="true"/,
    );
    expect(html).toMatch(
      /mode=magic[^"]*"\s+role="tab"\s+aria-selected="false"/,
    );
  });
});

describe("validateReturnTo", () => {
  it("accepts relative paths starting with /", () => {
    expect(validateReturnTo("/auth/authorize?client_id=abc")).toBe(
      "/auth/authorize?client_id=abc",
    );
    expect(validateReturnTo("/")).toBe("/");
    expect(validateReturnTo("/foo/bar")).toBe("/foo/bar");
  });

  it("falls back to / for unsafe values", () => {
    expect(validateReturnTo("https://evil.com/")).toBe("/");
    expect(validateReturnTo("//evil.com/path")).toBe("/");
    expect(validateReturnTo("javascript:alert(1)")).toBe("/");
    expect(validateReturnTo("foo")).toBe("/");
    expect(validateReturnTo("")).toBe("/");
    expect(validateReturnTo(undefined)).toBe("/");
    expect(validateReturnTo(null)).toBe("/");
    expect(validateReturnTo(42)).toBe("/");
  });
});

describe("GET /auth/sign-in", () => {
  it("returns 200 + text/html with the form", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await request(ctx.app, "GET", "/auth/sign-in", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Sign in to Myme");
    expect(html).toContain('action="/auth/sign-in"');
  });

  it("§3.18: returns Cache-Control: no-store + Pragma: no-cache", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/sign-in", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "no-store, no-cache, private",
    );
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("preserves return_to in the form's hidden field", async () => {
    ctx = await createTestContext();
    const returnTo = "/auth/authorize?client_id=abc&response_type=code";
    const res = await request(
      ctx.app,
      "GET",
      `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
    expect(html).toContain(
      `<input type="hidden" name="return_to" value="${returnTo
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}">`,
    );
  });

  it("renders mode=magic when ?mode=magic is set", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/sign-in?mode=magic", {
      headers: { origin: ORIGIN },
    });
    const html = await res.text();
    expect(html).toContain('value="magic"');
    expect(html).not.toContain('name="password"');
  });

  it("renders sign-up link when allowSignup=true", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await request(ctx.app, "GET", "/auth/sign-in", {
      headers: { origin: ORIGIN },
    });
    const html = await res.text();
    expect(html).toContain("/auth/sign-up");
  });

  it("hides sign-up link when allowSignup=false", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await request(ctx.app, "GET", "/auth/sign-in", {
      headers: { origin: ORIGIN },
    });
    const html = await res.text();
    expect(html).not.toContain("Create one");
  });

  it("surfaces error code from query as a role=alert banner", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/sign-in?error=invalid_credentials",
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("That email or password is wrong");
  });

  it("surfaces sent=1 from query as a role=status banner", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/sign-in?mode=magic&sent=1",
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
    expect(html).toContain('role="status"');
    expect(html).toContain("Check your email");
  });
});

describe("POST /auth/sign-in (form wrapper)", () => {
  it("redirects to /auth/sign-in?error=invalid_credentials on bad password", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // First, create the account so the credential check has a target.
    const signUp = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "alice@example.com",
        password: "correct horse",
        name: "Alice",
      },
      headers: { origin: ORIGIN },
    });
    expect(signUp.status).toBe(200);

    // Then submit the form-handler with a wrong password.
    const formBody = new URLSearchParams({
      mode: "password",
      email: "alice@example.com",
      password: "wrong",
      return_to: "/",
    });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: formBody.toString(),
      }),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in");
    expect(location).toContain("error=invalid_credentials");
  });

  it("redirects to /auth/sign-in?error=missing_field when email is empty", async () => {
    ctx = await createTestContext();
    const formBody = new URLSearchParams({
      mode: "password",
      email: "",
      password: "x",
      return_to: "/",
    });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: formBody.toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=missing_field");
  });

  it("redirects to return_to with Set-Cookie on successful sign-in", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "bob@example.com",
        password: "correct horse",
        name: "Bob",
      },
      headers: { origin: ORIGIN },
    });

    const formBody = new URLSearchParams({
      mode: "password",
      email: "bob@example.com",
      password: "correct horse",
      return_to: "/auth/authorize?client_id=abc",
    });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: formBody.toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/authorize?client_id=abc");
    // The Set-Cookie from Better Auth's session response should be forwarded.
    const cookies =
      typeof (res.headers as Headers & { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (
            res.headers as Headers & {
              getSetCookie: () => string[];
            }
          ).getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    expect(cookies.some((c) => c.includes("myme.auth"))).toBe(true);
  });

  it("succeeds when browser sends Origin: null (privacy-strict referrer policy)", async () => {
    // Regression test for the bug where Chrome serializes Origin as the
    // literal string "null" on form-POST navigations under strict
    // referrer policies — Better Auth's CSRF check was rejecting these
    // with MISSING_OR_NULL_ORIGIN before the wrapper learned to fall
    // back to auth.baseURL on null/missing Origin.
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "edgar@example.com",
        password: "correct horse",
        name: "Edgar",
      },
      headers: { origin: ORIGIN },
    });

    const formBody = new URLSearchParams({
      mode: "password",
      email: "edgar@example.com",
      password: "correct horse",
      return_to: "/",
    });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // Browser-style: literal "null" Origin from a privacy-strict
          // referrer policy. The wrapper should fall back to
          // auth.baseURL when dispatching to Better Auth.
          origin: "null",
        },
        body: formBody.toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookies =
      typeof (res.headers as Headers & { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (
            res.headers as Headers & { getSetCookie: () => string[] }
          ).getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    expect(cookies.some((c) => c.includes("myme.auth"))).toBe(true);
  });

  it("succeeds when browser omits the Origin header entirely", async () => {
    // Some legacy browsers / curl-without-explicit-origin omit Origin
    // on POST. The wrapper falls back to auth.baseURL.
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "frank@example.com",
        password: "correct horse",
        name: "Frank",
      },
      headers: { origin: ORIGIN },
    });

    const formBody = new URLSearchParams({
      mode: "password",
      email: "frank@example.com",
      password: "correct horse",
      return_to: "/",
    });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // No Origin header.
        },
        body: formBody.toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("rejects unsafe return_to values and falls back to /", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "carol@example.com",
        password: "correct horse",
        name: "Carol",
      },
      headers: { origin: ORIGIN },
    });
    const formBody = new URLSearchParams({
      mode: "password",
      email: "carol@example.com",
      password: "correct horse",
      return_to: "https://evil.com/",
    });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: formBody.toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
