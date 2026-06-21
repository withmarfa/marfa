import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  renderSignInPage,
  synthesizeOauthReturnTo,
  validateReturnTo,
} from "./sign-in-page.js";

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

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("renderSignInPage", () => {
  it("renders the password view with the right action + hidden return_to", () => {
    const html = renderSignInPage({
      returnTo: "/auth/authorize?client_id=abc",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('<form method="POST" action="/auth/sign-in"');
    // Default view submits mode=password; the one-time-link path is a GET form
    // in the alternatives row, distinguished by button text from the magic
    // submit.
    expect(html).toContain('name="mode" value="password"');
    expect(html).toContain('<form method="GET" action="/auth/sign-in">');
    expect(html).toContain(">One-time link</button>");
    expect(html).not.toContain("Email me a sign-in link");
    expect(html).toContain(
      '<input type="hidden" name="return_to" value="/auth/authorize?client_id=abc">',
    );
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
  });

  it("structures the password form with fields in .form and the button in .actions", () => {
    const html = renderSignInPage({
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    // The primary button lives in an .actions block inside the form (uniform
    // with sign-up), so it renders full width below the fields.
    expect(html).toMatch(
      /<div class="actions">\s*<button type="submit" name="mode" value="password" class="btn btn--primary"/,
    );
    expect(html).toContain('data-loading-label="Signing in..."');
  });

  it("renders the 'Or continue with' separator and the two-button alternatives row", () => {
    const html = renderSignInPage({
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('<div class="separator">Or continue with</div>');
    expect(html).toContain('<div class="alts">');
    // One-time link + the (hidden) passkey button both live in the row.
    expect(html).toContain(">One-time link</button>");
    expect(html).toContain('id="passkey-signin"');
    expect(html).toContain(">Passkey</button>");
  });

  it("includes the submit-state script on the password view", () => {
    const html = renderSignInPage({
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain(
      '<script src="/auth/static/submit-state.js"></script>',
    );
  });

  it("marks both forms novalidate so the native validation bubble never shows", () => {
    // The browser's own tooltip is replaced by the inline field-level errors
    // from submit-state.js; novalidate is what suppresses the native bubble.
    const passwordView = renderSignInPage({
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(passwordView).toContain(
      '<form method="POST" action="/auth/sign-in" novalidate>',
    );
    const magicView = renderSignInPage({
      mode: "magic",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(magicView).toContain(
      '<form method="POST" action="/auth/sign-in" class="form" novalidate>',
    );
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

  it("loads the password-toggle script on the password view only", () => {
    const passwordView = renderSignInPage({
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(passwordView).toContain(
      '<script src="/auth/static/password-toggle.js"></script>',
    );
    // The one-time-email view has no password field, so no toggle.
    const magicView = renderSignInPage({
      mode: "magic",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(magicView).not.toContain("/auth/static/password-toggle.js");
  });

  it("puts the one-time-email path on its own screen, linked from the password view", () => {
    const passwordView = renderSignInPage({
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    // Password view: a GET form to the one-time-email screen, not an inline
    // submit. Distinguished from the magic view by the button text.
    expect(passwordView).toContain(">One-time link</button>");
    expect(passwordView).toContain(
      '<form method="GET" action="/auth/sign-in">',
    );
    expect(passwordView).not.toContain("Email me a sign-in link");

    const magicView = renderSignInPage({
      mode: "magic",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    // Magic view: email-only form + the magic submit + a way back. No password.
    expect(magicView).toContain('name="email"');
    expect(magicView).toContain('name="mode" value="magic"');
    expect(magicView).not.toContain('name="password"');
    expect(magicView).toContain("Back to password sign-in");
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

  it("renders no OIDC provider buttons when providers list is empty", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    // No federated provider POST forms.
    expect(html).not.toContain('action="/auth/sign-in/provider/');
    expect(html).not.toContain("Continue with");
    // The passkey block reuses `.separator` + `.oidc` classes, so we
    // don't assert their absence here.
  });

  it("renders invalid_credentials as an inline form-level error, not a top banner", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/",
      error: "invalid_credentials",
      allowSignup: false,
      oidcProviderIds: [],
    });
    // The credential error spans email + password, so it renders as an inline
    // .form__error line above the actions, never the boxed top banner. (The
    // always-present hidden passkey-error div is a banner, so we assert the
    // credential copy itself isn't inside a banner rather than that no banner
    // class exists at all.)
    expect(html).toContain(
      'class="form__error" role="alert">That email or password is wrong',
    );
  });

  it("falls back to a generic message for unknown error codes (top banner on password view)", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/",
      error: "some_unknown_code",
      allowSignup: false,
      oidcProviderIds: [],
    });
    // A non-credential, non-field error still renders as the top banner.
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
  });

  it("renders a magic-view error under the email field, not a top banner", () => {
    const html = renderSignInPage({
      mode: "magic",
      returnTo: "/",
      error: "magic_send_failed",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain('class="field field--error"');
    expect(html).toContain('class="field__error"');
    expect(html).toContain("couldn&#39;t send the sign-in link");
    expect(html).not.toContain('class="banner banner--error"');
  });

  it("renders a dedicated 'Check your email' screen when magicLinkSent", () => {
    const html = renderSignInPage({
      mode: "magic",
      returnTo: "/",
      magicLinkSent: true,
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain("Check your email");
    expect(html).toContain('role="status"');
    // A focused confirmation screen — no password field, with a way back.
    expect(html).not.toContain('name="password"');
    expect(html).toContain("Use a password instead");
  });

  it("links to /auth/static/auth.css and carries no inline <style>", () => {
    const html = renderSignInPage({
      mode: "password",
      returnTo: "/",
      allowSignup: false,
      oidcProviderIds: [],
    });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
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

  it("strips sign-in-page-local params (mode / error / sent / return_to)", () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "abc",
      sig: "x",
      mode: "magic",
      error: "invalid_credentials",
      sent: "1",
      return_to: "/foo",
    });
    const returnTo = synthesizeOauthReturnTo(params);
    expect(returnTo).not.toContain("mode=");
    expect(returnTo).not.toContain("error=");
    expect(returnTo).not.toContain("sent=");
    expect(returnTo).not.toContain("return_to=");
    expect(returnTo).toContain("response_type=code");
  });

  it("returns bare /auth/authorize when only local params are present", () => {
    const params = new URLSearchParams({ mode: "magic", error: "x" });
    expect(synthesizeOauthReturnTo(params)).toBe("/auth/authorize");
  });

  it("always produces a same-origin path (validateReturnTo accepts it)", () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "abc",
      sig: "x",
    });
    const returnTo = synthesizeOauthReturnTo(params);
    expect(validateReturnTo(returnTo)).toBe(returnTo);
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
    expect(html).toContain("Sign in to Marfa");
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

  it("renders the one-time-email view (email only, no password) when ?mode=magic", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/sign-in?mode=magic", {
      headers: { origin: ORIGIN },
    });
    const html = await res.text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="mode" value="magic"');
    expect(html).not.toContain('name="password"');
    expect(html).toContain("Back to password sign-in");
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
    expect(html).toMatch(
      /<input type="hidden" name="return_to" value="\/auth\/authorize\?[^"]*response_type=code/,
    );
    expect(html).toContain("client_id=client-xyz");
    expect(html).toContain("sig=signature-stub");
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
    const html = await res.text();
    expect(html).toContain(
      '<input type="hidden" name="return_to" value="/auth/authorize?a=1">',
    );
    // Synthesized URL would carry client_id=xx; absent means explicit won.
    expect(html).not.toMatch(/return_to[^"]*client_id=xx/);
  });

  it("does NOT synthesize when no OAuth indicator (response_type) is present", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/sign-in?client_id=stray&mode=password",
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
    // Bare /auth/sign-in (no return_to and no response_type) → form
    // carries return_to="/" — the long-standing default.
    expect(html).toContain('name="return_to" value="/"');
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

  it("OAuth-init URL round-trip: GET synthesizes return_to, POST honors it (bug fix)", async () => {
    // The bug this fix addresses: when @better-auth/oauth-provider's
    // `loginPage` redirects an unauthenticated user from
    // /auth/oauth2/authorize to /auth/sign-in, it appends OAuth params
    // directly (not wrapped in return_to). Pre-fix the form lost them
    // on submit and the success redirect landed on `/`. Post-fix the
    // GET handler synthesizes return_to=/auth/authorize?<params>, the
    // hidden field carries it forward, POST honors it, user lands at
    // the consent screen as RFC 6749 §3.1 prescribes.
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "carla@example.com",
        password: "correct horse",
        name: "Carla",
      },
      headers: { origin: ORIGIN },
    });
    await markEmailVerified(ctx.storage, "carla@example.com");

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
      mode: "password",
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
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "dora@example.com",
        password: "correct horse",
        name: "Dora",
      },
      headers: { origin: ORIGIN },
    });
    await markEmailVerified(ctx.storage, "dora@example.com");
    const formBody = new URLSearchParams({
      mode: "password",
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
    ctx = await createTestContext({ authAllowSignup: true });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "bob@example.com",
        password: "correct horse",
        name: "Bob",
      },
      headers: { origin: ORIGIN },
    });
    // requireEmailVerification is on; flip the flag so sign-in isn't
    // blocked — stand-in for the user clicking the verification link.
    await markEmailVerified(ctx.storage, "bob@example.com");

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
    expect(cookies.some((c) => c.includes("marfa.auth"))).toBe(true);
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
    await markEmailVerified(ctx.storage, "edgar@example.com");

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
    expect(cookies.some((c) => c.includes("marfa.auth"))).toBe(true);
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
    await markEmailVerified(ctx.storage, "frank@example.com");

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
    await markEmailVerified(ctx.storage, "carol@example.com");
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
