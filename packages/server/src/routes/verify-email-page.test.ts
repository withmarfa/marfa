import { describe, it, expect } from "vitest";
import { renderVerifyEmailPage } from "./verify-email-page.js";

/**
 * `renderVerifyEmailPage` covers the four states of the `/auth/verify-email`
 * surface (pending / success / failure / resent). Handler-side smoke
 * (POST-then-redirect, token forwarding) lives in email-verification.test.ts;
 * this file asserts the HTML shape directly.
 */

describe("renderVerifyEmailPage", () => {
  it("links to the shared stylesheet and has no inline <style>", () => {
    const html = renderVerifyEmailPage({ state: "pending" });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("pending state renders the resend form with the inbox-check copy", () => {
    const html = renderVerifyEmailPage({
      state: "pending",
      email: "alice@example.com",
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(html).toContain("Verify your email");
    expect(html).toContain("verification email");
    expect(html).toContain('action="/auth/verify-email/resend"');
    expect(html).toContain('value="alice@example.com"');
    expect(html).toContain(
      '<input type="hidden" name="return_to" value="/auth/authorize?client_id=abc">',
    );
  });

  it("pending state without email renders an empty resend form", () => {
    const html = renderVerifyEmailPage({ state: "pending" });
    expect(html).toContain('action="/auth/verify-email/resend"');
    expect(html).toContain('value=""');
    // Default return_to falls back to "/" when omitted.
    expect(html).toContain('<input type="hidden" name="return_to" value="/">');
  });

  it("success state renders a status banner and continue link", () => {
    const html = renderVerifyEmailPage({
      state: "success",
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(html).toContain('class="banner banner--success"');
    expect(html).toContain('role="status"');
    expect(html).toContain("you're signed in");
    expect(html).toContain('href="/auth/authorize?client_id=abc"');
    expect(html).toContain("Continue");
    // No resend form on success.
    expect(html).not.toContain('action="/auth/verify-email/resend"');
  });

  it("failure state with expired code renders the expired-link banner", () => {
    const html = renderVerifyEmailPage({
      state: "failure",
      failureCode: "expired",
      email: "alice@example.com",
    });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("expired");
    expect(html).toContain('value="alice@example.com"');
    expect(html).toContain('action="/auth/verify-email/resend"');
  });

  it("failure state with invalid code renders the invalid-link banner", () => {
    const html = renderVerifyEmailPage({
      state: "failure",
      failureCode: "invalid",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("invalid");
  });

  it("failure state with unknown code falls back to a generic message", () => {
    const html = renderVerifyEmailPage({
      state: "failure",
      failureCode: "unknown",
    });
    expect(html).toContain('role="alert"');
    // Apostrophes in the failure-message branch flow through
    // `escapeHtml`, so the rendered form is `couldn&#39;t`.
    expect(html).toContain("couldn&#39;t verify");
  });

  it("resent state renders a success banner + the resend form (so user can resend again)", () => {
    const html = renderVerifyEmailPage({
      state: "resent",
      email: "alice@example.com",
    });
    expect(html).toContain('class="banner banner--success"');
    expect(html).toContain("fresh verification email");
    expect(html).toContain('action="/auth/verify-email/resend"');
  });

  it("escapes email + return_to to prevent template injection", () => {
    const html = renderVerifyEmailPage({
      state: "pending",
      email: '"><script>alert(1)</script>',
      returnTo: '/foo"><script>x</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
