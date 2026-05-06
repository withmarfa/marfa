import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { renderSignUpPage } from "./sign-up-page.js";

/**
 * Smoke tests for GET /auth/sign-up (HTML page) + the POST /auth/sign-up
 * form-handler that wraps Better Auth's POST /auth/sign-up/email. Coverage:
 *   - GET 200 + text/html when allowSignup=true
 *   - GET 404 when allowSignup=false
 *   - POST 302 with auto-sign-in cookie on success
 *   - POST 302 + error=email_exists when email is taken
 *   - POST 302 + error=password_mismatch / weak_password / missing_field / email_invalid
 *   - POST 404 when allowSignup=false (defence-in-depth past the GET gate)
 *   - return_to round-trips through the form
 */

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("renderSignUpPage", () => {
  it("renders form with email + name + password + password_confirm fields", () => {
    const html = renderSignUpPage({ returnTo: "/" });
    expect(html).toContain('<form method="POST" action="/auth/sign-up"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="password_confirm"');
    expect(html).toContain("Create account");
  });

  it("preserves return_to in the form's hidden field", () => {
    const html = renderSignUpPage({
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(html).toContain(
      '<input type="hidden" name="return_to" value="/auth/authorize?client_id=abc">',
    );
  });

  it("renders error banner with role=alert when error is set", () => {
    const html = renderSignUpPage({
      returnTo: "/",
      error: "email_exists",
    });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("already exists");
  });

  it("falls back to a generic message for unknown error codes", () => {
    const html = renderSignUpPage({ returnTo: "/", error: "unknown_code" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
  });

  it("escapes HTML in returnTo to prevent template injection", () => {
    const html = renderSignUpPage({
      returnTo: '/foo"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("Wave C PR4: links to /auth/static/auth.css and carries no inline <style>", () => {
    const html = renderSignUpPage({ returnTo: "/" });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("renders a sign-in link with return_to preserved", () => {
    const html = renderSignUpPage({
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(html).toContain('href="/auth/sign-in?return_to=');
  });
});

describe("GET /auth/sign-up", () => {
  it("returns 200 + text/html when allowSignup=true", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await request(ctx.app, "GET", "/auth/sign-up", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Create your Myme account");
  });

  it("returns 404 when allowSignup=false", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await request(ctx.app, "GET", "/auth/sign-up", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it("§3.18: returns Cache-Control: no-store + Pragma: no-cache", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await request(ctx.app, "GET", "/auth/sign-up", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "no-store, no-cache, private",
    );
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("preserves return_to from query in the hidden field", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const returnTo = "/auth/authorize?client_id=abc";
    const res = await request(
      ctx.app,
      "GET",
      `/auth/sign-up?return_to=${encodeURIComponent(returnTo)}`,
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
    expect(html).toContain(
      `<input type="hidden" name="return_to" value="${returnTo
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}">`,
    );
  });
});

describe("POST /auth/sign-up (form wrapper)", () => {
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

  it("returns 404 when allowSignup=false", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(404);
  });

  it("redirects to error=missing_field when fields are blank", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await postSignUpForm(ctx, {
      email: "",
      name: "",
      password: "",
      password_confirm: "",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=missing_field");
  });

  it("redirects to error=password_mismatch when passwords differ", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      password: "correct horse",
      password_confirm: "different",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=password_mismatch");
  });

  it("redirects to error=weak_password when password is too short", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      password: "short",
      password_confirm: "short",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=weak_password");
  });

  it("redirects to error=email_invalid when email is malformed", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await postSignUpForm(ctx, {
      email: "not-an-email",
      name: "Alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=email_invalid");
  });

  it("redirects to return_to with auto-sign-in cookie on success", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/auth/authorize?client_id=abc",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/authorize?client_id=abc");
    const cookies =
      typeof (res.headers as Headers & { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (
            res.headers as Headers & { getSetCookie: () => string[] }
          ).getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    expect(cookies.some((c) => c.includes("myme.auth"))).toBe(true);
  });

  it("redirects to error=email_exists when email is taken", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // First sign-up succeeds
    const first = await postSignUpForm(ctx, {
      email: "carol@example.com",
      name: "Carol",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(first.status).toBe(302);

    // Second with same email surfaces email_exists
    const second = await postSignUpForm(ctx, {
      email: "carol@example.com",
      name: "Carol Again",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toContain("error=email_exists");
  });

  it("rejects unsafe return_to values and redirects to /", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await postSignUpForm(ctx, {
      email: "dave@example.com",
      name: "Dave",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "https://evil.com/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
