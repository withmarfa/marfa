import { afterEach, describe, expect, it } from "vitest";
import { pageAssetUrl } from "../pages/assets.js";
import {
  pageField,
  pageFieldError,
  pageForms,
  pageLinks,
  visibleText,
} from "../pages/reading.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";
import {
  synthesizeOauthReturnTo,
  validateReturnTo,
} from "./sign-in-return.js";
import { renderSignInPage } from "./test-render.js";

/**
 * Smoke tests for GET /auth/sign-in (HTML page) + the POST /auth/sign-in
 * form-handler that wraps Better Auth's JSON API. Coverage:
 *   - 200 + text/html + form action/method correct
 *   - return_to round-trips through the form's hidden field
 *   - the form posts email and password, and is a plain post with no script
 *   - error query param surfaces as the password field's error, with focus on it
 *   - validateReturnTo rejects open-redirect attempts
 *   - POST /auth/sign-in with bad credentials redirects with error code
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** The cookie a sign-in sets, in the form a request sends it back. */
async function signInCookie(
  c: TestContext,
  email: string,
  password: string,
): Promise<string> {
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    res.headers.get("set-cookie") ?? "",
  );
  if (!match?.[1]) throw new Error("sign-in: no session cookie");
  return match[1];
}

describe("renderSignInPage", () => {
  it("renders a form that posts email and password, with the return_to in a hidden field", () => {
    const html = renderSignInPage({
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(pageForms(html)).toEqual([
      { method: "post", action: "/auth/sign-in", novalidate: true },
    ]);
    expect(pageField(html, "return_to")).toMatchObject({
      type: "hidden",
      value: "/auth/authorize?client_id=abc",
    });
    expect(pageField(html, "email")).toMatchObject({ type: "email" });
    expect(pageField(html, "password")).toMatchObject({ type: "password" });
    expect(visibleText(html)).toContain("Sign in");
  });

  it("works as a plain form post: the fields are required and the form needs no script to submit", () => {
    const html = renderSignInPage({ returnTo: "/" });
    expect(html).toMatch(/<input[^>]*name="email"[^>]*required/);
    expect(html).toMatch(/<input[^>]*name="password"[^>]*required/);
    expect(html).toMatch(/<button[^>]*type="submit"/);
    // The passkey block starts hidden, so a browser with no script shows no
    // button that does nothing.
    expect(html).toMatch(/<div[^>]*data-passkey-signin[^>]*hidden/);
  });

  it("leads to the forgotten-password page, and says so in words", () => {
    const html = renderSignInPage({ returnTo: "/" });
    expect(pageLinks(html)).toContainEqual({
      href: "/auth/forgot-password",
      text: "Forgot password?",
    });
  });

  it("lists what takes focus in reading order, with no tabindex: email, password, Sign in, Forgot password, the passkey button", () => {
    const html = renderSignInPage({ returnTo: "/" });
    const stops = [
      /name="email"/,
      /name="password"/,
      /type="submit"/,
      /href="\/auth\/forgot-password"/,
      /data-hook="passkey-signin"/,
    ].map((pattern) => html.search(pattern));
    expect(stops.every((at) => at >= 0)).toBe(true);
    expect([...stops].sort((a, b) => a - b)).toEqual(stops);
    expect(html).not.toMatch(/<(?:input|a|button)\b[^>]*tabindex/);
  });

  it("escapes HTML in returnTo to prevent template injection", () => {
    const html = renderSignInPage({
      returnTo: '/foo"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(pageField(html, "return_to")?.value).toBe(
      '/foo"><script>alert(1)</script>',
    );
  });

  it("says a wrong email or password is wrong under the password field, marks both fields invalid and moves focus to the password", () => {
    const html = renderSignInPage({
      returnTo: "/",
      error: "invalid_credentials",
      email: "dana@example.com",
    });
    expect(pageFieldError(html, "password")).toBe(
      "That email or password is wrong.",
    );
    // The server does not say which of the two was wrong, so both are marked,
    // and the email field points at the same message.
    expect(pageField(html, "email")).toMatchObject({
      invalid: true,
      describedBy: pageField(html, "password")?.describedBy,
    });
    expect(pageField(html, "password")?.invalid).toBe(true);
    // The password has to be typed again, so it takes focus; the email, which
    // came back, does not.
    expect(pageField(html, "password")?.autofocus).toBe(true);
    expect(pageField(html, "email")?.autofocus).toBe(false);
    // The error is said once, on the field, and not again in a box.
    expect(html.match(/That email or password is wrong/g)).toHaveLength(1);
  });

  it("asks for what is missing under the password field and focuses the email when it is the empty one", () => {
    const noEmail = renderSignInPage({ returnTo: "/", error: "missing_field" });
    expect(pageFieldError(noEmail, "password")).toBe(
      "Enter your email and password.",
    );
    expect(pageField(noEmail, "email")).toMatchObject({
      invalid: true,
      autofocus: true,
    });
    const noPassword = renderSignInPage({
      returnTo: "/",
      error: "missing_field",
      email: "dana@example.com",
    });
    expect(pageField(noPassword, "email")?.invalid).toBe(false);
    expect(pageField(noPassword, "password")).toMatchObject({
      invalid: true,
      autofocus: true,
    });
  });

  it("marks no field invalid and shows no error on a fresh page", () => {
    const html = renderSignInPage({ returnTo: "/" });
    expect(html).not.toContain("aria-invalid");
    expect(pageFieldError(html, "password")).toBeUndefined();
  });

  it("focuses the email field on a fresh page, and the password field when the email came back", () => {
    const fresh = renderSignInPage({ returnTo: "/" });
    expect(pageField(fresh, "email")?.autofocus).toBe(true);
    expect(pageField(fresh, "password")?.autofocus).toBe(false);
    const typed = renderSignInPage({ returnTo: "/", email: "a@example.com" });
    expect(pageField(typed, "email")?.autofocus).toBe(false);
    expect(pageField(typed, "password")?.autofocus).toBe(true);
  });

  it("falls back to a generic message for unknown error codes", () => {
    const html = renderSignInPage({
      returnTo: "/",
      error: "some_unknown_code",
    });
    expect(pageFieldError(html, "password")).toBe(
      "Something went wrong. Try again.",
    );
  });

  describe("when sign-in is refused for too many attempts", () => {
    const locked = (retryAfter?: number) =>
      visibleText(
        renderSignInPage({
          returnTo: "/",
          error: "too_many_attempts",
          retryAfter,
        }),
      );

    it("says how long to wait in whole minutes, rounded up", () => {
      for (const [seconds, said] of [
        [1, "1 minute"],
        [59, "1 minute"],
        [60, "1 minute"],
        [61, "2 minutes"],
        [899, "15 minutes"],
        [900, "15 minutes"],
        [901, "16 minutes"],
        [3600, "60 minutes"],
      ] as const)
        expect(locked(seconds), String(seconds)).toContain(
          `Try again in ${said}`,
        );
    });

    it("says a passkey still signs in, in the same sentence as the wait", () => {
      expect(locked(120)).toContain(
        "Try again in 2 minutes, or sign in with a passkey.",
      );
    });

    it("puts the lockout under the password field, and does not mark the email field invalid", () => {
      const html = renderSignInPage({
        returnTo: "/",
        error: "too_many_attempts",
        retryAfter: 600,
        email: "dana@example.com",
      });
      expect(pageFieldError(html, "password")).toBe(
        "Too many attempts. Try again in 10 minutes, or sign in with a passkey.",
      );
      expect(pageField(html, "email")?.invalid).toBe(false);
      expect(pageField(html, "password")?.autofocus).toBe(true);
    });

    it("never invents a number when it was given no wait", () => {
      const text = locked(undefined);
      expect(text).toContain("Too many attempts");
      expect(text).not.toMatch(/\d+ minutes?/);
    });

    it("keeps the typed email and does not call the password wrong", () => {
      const html = renderSignInPage({
        returnTo: "/",
        error: "too_many_attempts",
        retryAfter: 600,
        email: "dana@example.com",
      });
      expect(pageField(html, "email")?.value).toBe("dana@example.com");
      expect(visibleText(html)).not.toContain("is wrong");
    });
  });

  it("loads the page system's stylesheet and script, with no inline style", () => {
    const html = renderSignInPage({ returnTo: "/" });
    expect(html).toContain(`href="${pageAssetUrl("pages.css")}"`);
    expect(html).toContain(`src="${pageAssetUrl("pages.js")}"`);
    expect(html).not.toContain("<style>");
    expect(html).not.toMatch(/\sstyle=/);
  });
});

describe("validateReturnTo", () => {
  const ISSUER = "http://localhost:0";

  it("accepts a path on the instance, normalized", () => {
    expect(validateReturnTo("/auth/authorize?client_id=abc", ISSUER)).toBe(
      "/auth/authorize?client_id=abc",
    );
    expect(validateReturnTo("/", ISSUER)).toBe("/");
    expect(validateReturnTo("/foo/bar#frag", ISSUER)).toBe("/foo/bar#frag");
    expect(validateReturnTo("/a/../b", ISSUER)).toBe("/b");
    expect(validateReturnTo(`${ISSUER}/auth/device`, ISSUER)).toBe(
      "/auth/device",
    );
  });

  it("carries a long address whole, as an authorize request can be", () => {
    const long = `/auth/authorize?${new URLSearchParams({ state: "s".repeat(6000), client_id: "abc" }).toString()}`;
    expect(long.length).toBeGreaterThan(6000);
    expect(validateReturnTo(long, ISSUER)).toBe(long);
  });

  it("falls back to / for anything that lands off the instance", () => {
    for (const raw of [
      "https://evil.com/",
      "//evil.com/path",
      "/\\evil.com",
      "\\\\evil.com",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "\t//evil.example",
      " //evil.example",
      "/\t\\evil.example",
      // Resolving collapses dot segments into a path the browser reads as
      // another host.
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/.\\/evil.example",
      "//localhost:0//evil.example",
      "javascript:alert(1)",
      "data:text/html,hi",
      "http://localhost:1/",
      "",
      undefined,
      null,
      42,
    ]) {
      expect(validateReturnTo(raw, ISSUER), JSON.stringify(raw)).toBe("/");
    }
  });
});

describe("synthesizeOauthReturnTo", () => {
  it("wraps OAuth params into a /auth/authorize URL", () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "abc",
      redirect_uri: "http://localhost:8080/cb",
      scope: "openid profile email",
      state: "xyz",
      code_challenge: "challenge123",
      code_challenge_method: "S256",
      sig: "signed",
    });
    const returnTo = synthesizeOauthReturnTo(params);
    expect(returnTo).toMatch(/^\/auth\/authorize\?/);
    expect(returnTo).toContain("response_type=code");
    expect(returnTo).toContain("client_id=abc");
    expect(returnTo).toContain("sig=signed");
    // Crucially preserves redirect_uri + code_challenge so the plugin's
    // signature re-check on resumption succeeds.
    expect(returnTo).toContain(
      "redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcb",
    );
    expect(returnTo).toContain("code_challenge=challenge123");
  });

  it("strips sign-in-page-local params (error / return_to)", () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "abc",
      sig: "x",
      error: "invalid_credentials",
      return_to: "/foo",
    });
    const returnTo = synthesizeOauthReturnTo(params);
    expect(returnTo).not.toContain("error=");
    expect(returnTo).not.toContain("return_to=");
    expect(returnTo).toContain("response_type=code");
  });

  it("returns bare /auth/authorize when only local params are present", () => {
    const params = new URLSearchParams({ error: "x", return_to: "/x" });
    expect(synthesizeOauthReturnTo(params)).toBe("/auth/authorize");
  });

  it("always produces a same-origin path (validateReturnTo accepts it)", () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "abc",
      sig: "x",
    });
    const returnTo = synthesizeOauthReturnTo(params);
    expect(validateReturnTo(returnTo, "http://localhost:0")).toBe(returnTo);
  });
});

describe("GET /auth/sign-in", () => {
  it("returns 200 + text/html with the form", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/sign-in", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(visibleText(html)).toContain("Sign in to Marfa");
    expect(pageForms(html)[0]?.action).toBe("/auth/sign-in");
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
    expect(pageField(await res.text(), "return_to")?.value).toBe(returnTo);
  });

  it("surfaces the error code from the query as the password field's error", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/sign-in?error=invalid_credentials",
      { headers: { origin: ORIGIN } },
    );
    expect(pageFieldError(await res.text(), "password")).toBe(
      "That email or password is wrong.",
    );
  });

  // -------------------------------------------------------------------
  // OAuth-param synthesis (bug fix: @better-auth/oauth-provider's
  // `loginPage` redirects with OAuth params appended directly onto
  // /auth/sign-in instead of wrapped in `return_to`, so the form lost
  // them on submit and the user landed on `/` after credential check.)
  // -------------------------------------------------------------------

  it("synthesizes return_to=/auth/authorize?… when OAuth params land on /auth/sign-in directly", async () => {
    ctx = await createTestContext();
    const oauthParams = new URLSearchParams({
      response_type: "code",
      client_id: "client-xyz",
      redirect_uri: "http://localhost:8080/cb",
      scope: "openid",
      state: "state123",
      code_challenge: "challenge123",
      code_challenge_method: "S256",
      sig: "signature-stub",
    });
    const res = await request(
      ctx.app,
      "GET",
      `/auth/sign-in?${oauthParams.toString()}`,
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The form's hidden return_to should now point back at /auth/authorize
    // carrying the full OAuth query string.
    const carried = pageField(html, "return_to")?.value ?? "";
    expect(carried).toMatch(/^\/auth\/authorize\?.*response_type=code/);
    expect(carried).toContain("client_id=client-xyz");
    expect(carried).toContain("sig=signature-stub");
  });

  it("prefers an explicit return_to over OAuth-param synthesis", async () => {
    // When BOTH `return_to` AND OAuth params are on the URL, the explicit
    // return_to wins — the well-behaved consent-gate path stays intact.
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/sign-in?return_to=%2Fauth%2Fauthorize%3Fa%3D1&response_type=code&client_id=xx",
      { headers: { origin: ORIGIN } },
    );
    const carried = pageField(await res.text(), "return_to")?.value;
    expect(carried).toBe("/auth/authorize?a=1");
    // Synthesized URL would carry client_id=xx; absent means explicit won.
    expect(carried).not.toContain("client_id=xx");
  });

  it("does NOT synthesize when no OAuth indicator (response_type) is present", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/sign-in?client_id=stray&mode=password",
      { headers: { origin: ORIGIN } },
    );
    // Bare /auth/sign-in (no return_to and no response_type) → form
    // carries return_to="/" — the long-standing default.
    expect(pageField(await res.text(), "return_to")?.value).toBe("/");
  });
});

describe("the sign-in page after a lockout", () => {
  it("promises no number of minutes when the address names none, or names nonsense", async () => {
    ctx = await createTestContext();
    for (const query of [
      "error=too_many_attempts",
      "error=too_many_attempts&retry_after=0",
      "error=too_many_attempts&retry_after=-5",
      "error=too_many_attempts&retry_after=soon",
      "error=too_many_attempts&retry_after=99999999",
      "error=too_many_attempts&retry_after=1.5",
    ]) {
      const res = await request(ctx.app, "GET", `/auth/sign-in?${query}`);
      const text = visibleText(await res.text());
      expect(text, query).toContain("Too many attempts");
      expect(text, query).not.toMatch(/\d+ minutes?/);
    }
    // Witness: a wait the server could have named is shown.
    const named = await request(
      ctx.app,
      "GET",
      "/auth/sign-in?error=too_many_attempts&retry_after=300",
    );
    expect(visibleText(await named.text())).toContain("Try again in 5 minutes");
  });

  it("keeps the lockout's own parameters out of the authorization it wraps", () => {
    expect(
      synthesizeOauthReturnTo(
        new URLSearchParams(
          "response_type=code&client_id=abc&error=too_many_attempts&retry_after=60",
        ),
      ),
    ).toBe("/auth/authorize?response_type=code&client_id=abc");
  });
});

describe("POST /auth/sign-in (form wrapper)", () => {
  it("redirects to /auth/sign-in?error=invalid_credentials on bad password", async () => {
    ctx = await createTestContext(undefined, {
      email: "alice@example.com",
      password: "correct horse",
      name: "Alice",
    });
    // First, create the account so the credential check has a target.

    // Then submit the form-handler with a wrong password.
    const formBody = new URLSearchParams({
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

  it("OAuth-init URL round-trip: GET synthesizes return_to, POST honors it (bug fix)", async () => {
    // The bug this fix addresses: when @better-auth/oauth-provider's
    // `loginPage` redirects an unauthenticated user from
    // /auth/oauth2/authorize to /auth/sign-in, it appends OAuth params
    // directly (not wrapped in return_to). Pre-fix the form lost them
    // on submit and the success redirect landed on `/`. Post-fix the
    // GET handler synthesizes return_to=/auth/authorize?<params>, the
    // hidden field carries it forward, POST honors it, user lands at
    // the consent screen as RFC 6749 §3.1 prescribes.
    ctx = await createTestContext(undefined, {
      email: "carla@example.com",
      password: "correct horse",
      name: "Carla",
    });

    // 1. GET /auth/sign-in with OAuth params directly on the URL —
    //    simulating the plugin's loginPage redirect shape.
    const oauthQuery = new URLSearchParams({
      response_type: "code",
      client_id: "client-roundtrip",
      redirect_uri: "http://localhost:8080/cb",
      scope: "openid profile",
      state: "rt-state",
      code_challenge: "ch",
      code_challenge_method: "S256",
      sig: "sig-stub",
    }).toString();
    const formGet = await request(
      ctx.app,
      "GET",
      `/auth/sign-in?${oauthQuery}`,
      { headers: { origin: ORIGIN } },
    );
    const html = await formGet.text();
    const match = /name="return_to" value="([^"]+)"/.exec(html);
    expect(match).not.toBeNull();
    const returnTo = (match?.[1] ?? "").replace(/&amp;/g, "&");
    expect(returnTo.startsWith("/auth/authorize?")).toBe(true);
    expect(returnTo).toContain("response_type=code");
    expect(returnTo).toContain("client_id=client-roundtrip");
    expect(returnTo).toContain("sig=sig-stub");

    // 2. POST credentials with that return_to → 302 lands at it.
    const formBody = new URLSearchParams({
      email: "carla@example.com",
      password: "correct horse",
      return_to: returnTo,
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
    expect(location.startsWith("/auth/authorize?")).toBe(true);
    expect(location).toContain("response_type=code");
    expect(location).toContain("client_id=client-roundtrip");
    expect(location).toContain("sig=sig-stub");
    const cookies =
      typeof (res.headers as Headers & { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (
            res.headers as Headers & { getSetCookie: () => string[] }
          ).getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    expect(cookies.some((c) => c.includes("marfa.auth"))).toBe(true);
  });

  it("rejects an off-origin return_to (open-redirect guard, defense in depth)", async () => {
    // validateReturnTo runs on the POST side too, so even if some
    // upstream slipped an absolute URL into the hidden field, the
    // wrapper falls back to "/" instead of redirecting off-origin.
    ctx = await createTestContext(undefined, {
      email: "dora@example.com",
      password: "correct horse",
      name: "Dora",
    });

    const formBody = new URLSearchParams({
      email: "dora@example.com",
      password: "correct horse",
      return_to: "https://attacker.example/steal",
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

  it("redirects to return_to with Set-Cookie on successful sign-in", async () => {
    ctx = await createTestContext(undefined, {
      email: "bob@example.com",
      password: "correct horse",
      name: "Bob",
    });

    const formBody = new URLSearchParams({
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
    expect(cookies.some((c) => c.includes("marfa.auth"))).toBe(true);
  });

  it("refuses a sign-in whose Origin is the opaque null", async () => {
    // A sandboxed frame on any page sends `Origin: null`, so it says nothing
    // about where the post came from. This server's own pages are served
    // under a referrer policy that keeps a real Origin on the form post.
    ctx = await createTestContext(undefined, {
      email: "edgar@example.com",
      password: "correct horse",
      name: "Edgar",
    });

    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "null",
        },
        body: new URLSearchParams({
          email: "edgar@example.com",
          password: "correct horse",
          return_to: "/",
        }).toString(),
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("succeeds when browser omits the Origin header entirely", async () => {
    // Some legacy browsers / curl-without-explicit-origin omit Origin
    // on POST. The wrapper falls back to auth.baseURL.
    ctx = await createTestContext(undefined, {
      email: "frank@example.com",
      password: "correct horse",
      name: "Frank",
    });

    const formBody = new URLSearchParams({
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

  it("never redirects off the instance on a return_to a browser would read as another host", async () => {
    ctx = await createTestContext(undefined, {
      email: "tab@example.com",
      password: "correct horse",
      name: "Tab",
    });

    // A browser removes tabs and newlines from a URL before resolving it,
    // and resolving collapses dot segments, so each of these reaches it as
    // `//evil.example`.
    for (const offInstance of [
      "/\t/evil.example",
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/.\\/evil.example",
      `${ORIGIN}//evil.example`,
    ]) {
      const page = await request(
        ctx.app,
        "GET",
        `/auth/sign-in?return_to=${encodeURIComponent(offInstance)}`,
      );
      expect(await page.text(), offInstance).toContain(
        'name="return_to" value="/"',
      );
      const res = await ctx.app.fetch(
        new Request(`${ORIGIN}/auth/sign-in`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ORIGIN,
          },
          body: new URLSearchParams({
            email: "tab@example.com",
            password: "correct horse",
            return_to: offInstance,
          }).toString(),
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location"), offInstance).toBe("/");
    }
  });

  it("rejects unsafe return_to values and falls back to /", async () => {
    ctx = await createTestContext(undefined, {
      email: "carol@example.com",
      password: "correct horse",
      name: "Carol",
    });

    const formBody = new URLSearchParams({
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

describe("the sign-in page keeps what was typed", () => {
  it("returns the email after a wrong password, and only the email", async () => {
    ctx = await createTestContext(undefined, {
      email: "dana@example.com",
      password: "correct horse",
      name: "Dana",
    });

    const failed = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          email: "dana@example.com",
          password: "wrong horse",
          return_to: "/",
        }).toString(),
      }),
    );
    const location = failed.headers.get("location") ?? "";
    expect(location).toContain("error=invalid_credentials");
    expect(location).not.toContain("wrong");

    const page = await ctx.app.fetch(new Request(`${ORIGIN}${location}`));
    const html = await page.text();
    expect(pageField(html, "email")?.value).toBe("dana@example.com");
    expect(pageField(html, "password")?.value).toBeUndefined();
  });

  it("escapes what it puts back in the field", () => {
    const html = renderSignInPage({
      returnTo: "/",
      email: '"><script>x</script>',
    });
    expect(html).not.toContain("<script>x</script>");
    expect(pageField(html, "email")?.value).toBe('"><script>x</script>');
  });

  it("leaves the field empty when nothing was typed", () => {
    expect(pageField(renderSignInPage({ returnTo: "/" }), "email")?.value).toBe(
      "",
    );
  });

  it("does not fold the typed email into the authorization it wraps", () => {
    const wrapped = synthesizeOauthReturnTo(
      new URLSearchParams(
        "response_type=code&client_id=abc&email=a%40b.example",
      ),
    );
    expect(wrapped).toBe("/auth/authorize?response_type=code&client_id=abc");
  });
});

describe("the sign-in page names the app that sent the person", () => {
  async function registeredApp(c: TestContext, name: string): Promise<string> {
    const res = await request(c.app, "POST", "/auth/oauth2/register", {
      body: {
        client_name: name,
        application_type: "native",
        redirect_uris: [`${ORIGIN}/callback`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      headers: { origin: ORIGIN },
    });
    return ((await res.json()) as { client_id: string }).client_id;
  }

  /** What the plugin sends an unsigned-in person to: the sign-in page with
   *  its own signed query on it. */
  async function signInUrlFor(
    c: TestContext,
    clientId: string,
  ): Promise<string> {
    const res = await request(
      c.app,
      "GET",
      `/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: `${ORIGIN}/callback`,
        scope: "core.note:read",
        state: "s",
        code_challenge: "0123456789012345678901234567890123456789012",
        code_challenge_method: "S256",
      }).toString()}`,
    );
    expect(res.status).toBe(302);
    return res.headers.get("location") ?? "";
  }

  it("says which app an authorization is signing in for", async () => {
    ctx = await createTestContext();
    const clientId = await registeredApp(ctx, "Named Notes");
    const signInUrl = await signInUrlFor(ctx, clientId);
    expect(signInUrl).toContain("/auth/sign-in");
    const page = await ctx.app.fetch(new Request(`${ORIGIN}${signInUrl}`));
    const text = visibleText(await page.text());
    expect(text).toContain("Sign in to continue to Named Notes.");
    // A self-registered app is flagged as the consent page flags it.
    expect(text).toContain("Marfa hasn't verified this app");
  });

  it("names nothing when the request was never signed", async () => {
    ctx = await createTestContext();
    const clientId = await registeredApp(ctx, "Forged Notes");
    // The same app, so that the absence below is the signature's doing: the
    // signed request in the case above names it.
    const forged = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: `${ORIGIN}/callback`,
      scope: "core.note:read",
      exp: String(Math.floor(Date.now() / 1000) + 600),
      sig: "forged",
    });
    const page = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/sign-in?return_to=${encodeURIComponent(`/auth/authorize?${forged.toString()}`)}`,
      ),
    );
    const text = visibleText(await page.text());
    expect(text).not.toContain("Forged Notes");
    expect(text).not.toContain("Sign in to continue to");
  });

  it("names nothing when the request was signed and has since been edited", async () => {
    ctx = await createTestContext();
    const clientId = await registeredApp(ctx, "Edited Notes");
    const signInUrl = await signInUrlFor(ctx, clientId);
    const edited = new URL(signInUrl, ORIGIN);
    edited.searchParams.set("scope", "core.note:write");
    const page = await ctx.app.fetch(new Request(edited));
    expect(visibleText(await page.text())).not.toContain("Edited Notes");
  });
});

describe("signing in with no app waiting", () => {
  it("ends at the server's address, which shows a signed-in browser Home", async () => {
    ctx = await createTestContext(undefined, {
      email: "erin@example.com",
      password: "correct horse",
      name: "Erin",
    });

    const signedIn = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          email: "erin@example.com",
          password: "correct horse",
        }).toString(),
      }),
    );
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe("/");

    const cookie = await signInCookie(ctx, "erin@example.com", "correct horse");
    const page = await request(ctx.app, "GET", "/", {
      headers: { cookie, accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toContain("no-store");
    const text = visibleText(await page.text());
    expect(text).toContain("Sign out");
    expect(text).toContain("Older management page");

    // Witness: the same address with no session is the page that says
    // nobody is, and a program is still given the JSON whoever it is.
    const anonymous = await request(ctx.app, "GET", "/", {
      headers: { accept: "text/html" },
    });
    const anonymousText = visibleText(await anonymous.text());
    expect(anonymousText).not.toContain("Sign out");
    expect(anonymousText).toContain("Marfa is running");
    const program = await request(ctx.app, "GET", "/", { headers: { cookie } });
    expect(program.headers.get("content-type")).toContain("application/json");
  });

  it("tells somebody already signed in so, on the sign-in page", async () => {
    ctx = await createTestContext(undefined, {
      email: "finn@example.com",
      password: "correct horse",
      name: "Finn",
    });

    const cookie = await signInCookie(ctx, "finn@example.com", "correct horse");
    const page = await request(ctx.app, "GET", "/auth/sign-in", {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(visibleText(html)).toContain("You're signed in");
    expect(visibleText(html)).toContain("finn@example.com");
    expect(pageField(html, "password")).toBeUndefined();
    // Witness: without a session the same address is the form.
    const anonymous = await (
      await request(ctx.app, "GET", "/auth/sign-in")
    ).text();
    expect(pageField(anonymous, "password")).toBeDefined();
  });

  it("still shows the form to a signed-in person an authorization sent to sign in afresh", async () => {
    ctx = await createTestContext(undefined, {
      email: "iris@example.com",
      password: "correct horse",
      name: "Iris",
    });

    const cookie = await signInCookie(ctx, "iris@example.com", "correct horse");
    // `prompt=login` is how an app asks for a new sign-in from somebody who
    // has a session; the plugin answers by sending them to the sign-in page.
    const page = await request(
      ctx.app,
      "GET",
      `/auth/sign-in?return_to=${encodeURIComponent("/auth/authorize?client_id=abc&prompt=login")}`,
      { headers: { cookie } },
    );
    const html = await page.text();
    expect(pageField(html, "password")).toBeDefined();
    expect(visibleText(html)).not.toContain("You're signed in");
    // Witness: the same person, sent nowhere in particular, is told.
    const elsewhere = await request(ctx.app, "GET", "/auth/sign-in", {
      headers: { cookie },
    });
    expect(visibleText(await elsewhere.text())).toContain("You're signed in");
  });

  it("offers to continue to where an already signed-in person was headed", async () => {
    ctx = await createTestContext(undefined, {
      email: "gail@example.com",
      password: "correct horse",
      name: "Gail",
    });

    const cookie = await signInCookie(ctx, "gail@example.com", "correct horse");
    const page = await request(
      ctx.app,
      "GET",
      `/auth/sign-in?return_to=${encodeURIComponent("/auth/device")}`,
      { headers: { cookie } },
    );
    expect(pageLinks(await page.text())).toContainEqual({
      href: "/auth/device",
      text: "Continue",
    });
  });
});
