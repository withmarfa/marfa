import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { renderResetPasswordPage } from "./reset-password-page.js";

/**
 * Wave C PR3 / T-033 — reset-password page renderer + handler smoke.
 * The full token round-trip (forgot → email → reset → sign-in) lives
 * in `password-reset.test.ts`; this file covers the renderer states +
 * the form-side validation paths.
 */

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("renderResetPasswordPage", () => {
  it("links to the shared stylesheet and has no inline <style>", () => {
    const html = renderResetPasswordPage({ state: "form", token: "x" });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("form state renders new-password + confirm + token round-trip", () => {
    const html = renderResetPasswordPage({
      state: "form",
      token: "abc",
      returnTo: "/auth/authorize?client_id=xyz",
    });
    expect(html).toContain('<form method="POST" action="/auth/reset-password"');
    expect(html).toContain('<input type="hidden" name="token" value="abc">');
    expect(html).toContain(
      '<input type="hidden" name="return_to" value="/auth/authorize?client_id=xyz">',
    );
    expect(html).toContain('name="password"');
    expect(html).toContain('name="password_confirm"');
    expect(html).toContain("Update password");
  });

  it("form state surfaces a formError banner when set", () => {
    const html = renderResetPasswordPage({
      state: "form",
      token: "x",
      formError: "password_mismatch",
    });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain("Passwords don&#39;t match");
  });

  it("success state renders a success banner + sign-in link", () => {
    const html = renderResetPasswordPage({
      state: "success",
      returnTo: "/foo",
    });
    expect(html).toContain('class="banner banner--success"');
    expect(html).toContain("Password updated");
    expect(html).toContain("other sessions have been signed out");
    expect(html).toContain('href="/auth/sign-in?return_to=/foo"');
    // No reset form on success.
    expect(html).not.toContain('action="/auth/reset-password"');
  });

  it("failure state with expired code renders the friendly expired message", () => {
    const html = renderResetPasswordPage({
      state: "failure",
      failureCode: "expired",
    });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain("expired");
    expect(html).toContain('href="/auth/forgot-password"');
  });

  it("failure state with invalid code renders the invalid-link message", () => {
    const html = renderResetPasswordPage({
      state: "failure",
      failureCode: "invalid",
    });
    expect(html).toContain("invalid");
  });

  it("escapes the token to prevent template injection", () => {
    const html = renderResetPasswordPage({
      state: "form",
      token: '"><script>x</script>',
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("GET /auth/reset-password", () => {
  it("redirects to /auth/forgot-password when no token is supplied", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/reset-password", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/forgot-password");
  });

  it("renders the form when ?token=… is present", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/reset-password?token=anytoken",
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Choose a new password");
    expect(html).toContain('value="anytoken"');
  });

  it("§3.18: returns Cache-Control: no-store + Pragma: no-cache", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/reset-password?token=x", {
      headers: { origin: ORIGIN },
    });
    expect(res.headers.get("cache-control")).toBe(
      "no-store, no-cache, private",
    );
  });
});

describe("POST /auth/reset-password (form wrapper)", () => {
  async function postForm(
    c: TestContext,
    fields: Record<string, string>,
  ): Promise<Response> {
    return c.app.fetch(
      new Request(`${ORIGIN}/auth/reset-password`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  }

  it("renders missing_field when token / password is blank", async () => {
    ctx = await createTestContext();
    const res = await postForm(ctx, {
      token: "",
      password: "",
      password_confirm: "",
      return_to: "/",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Please fill in every field");
  });

  it("renders password_mismatch when passwords differ", async () => {
    ctx = await createTestContext();
    const res = await postForm(ctx, {
      token: "x",
      password: "correct horse",
      password_confirm: "different",
      return_to: "/",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Passwords don&#39;t match");
  });

  it("renders weak_password when the password is too short", async () => {
    ctx = await createTestContext();
    const res = await postForm(ctx, {
      token: "x",
      password: "short",
      password_confirm: "short",
      return_to: "/",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("at least 8");
  });

  it("renders the failure state when better-auth rejects an invalid token", async () => {
    ctx = await createTestContext();
    const res = await postForm(ctx, {
      token: "totally-not-a-real-token",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Reset failed");
    expect(html).toContain('class="banner banner--error"');
  });
});
