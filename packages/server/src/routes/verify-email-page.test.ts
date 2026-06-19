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

  it("pending state with a known email offers a one-tap resend", () => {
    const html = renderVerifyEmailPage({
      state: "pending",
      email: "alice@example.com",
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(html).toContain("Verify your email");
    expect(html).toContain("Resend email");
    expect(html).toContain('action="/auth/verify-email/resend"');
    expect(html).toContain('value="alice@example.com"');
    expect(html).toContain(
      '<input type="hidden" name="return_to" value="/auth/authorize?client_id=abc">',
    );
  });

  it("pending state without email renders an empty resend field", () => {
    const html = renderVerifyEmailPage({ state: "pending" });
    expect(html).toContain('action="/auth/verify-email/resend"');
    expect(html).toContain('value=""');
    // Default return_to falls back to "/" when omitted.
    expect(html).toContain('<input type="hidden" name="return_to" value="/">');
  });

  it("success state confirms verification and offers a continue link", () => {
    const html = renderVerifyEmailPage({
      state: "success",
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(html).toContain("Email verified");
    expect(html).toContain('role="status"');
    expect(html).toContain("signed in");
    expect(html).toContain('href="/auth/authorize?client_id=abc"');
    expect(html).toContain("Continue");
    // No resend form on success.
    expect(html).not.toContain('action="/auth/verify-email/resend"');
  });

  it("failure state renders the unified 'that link didn't work' screen with an inline resend", () => {
    const html = renderVerifyEmailPage({
      state: "failure",
      email: "alice@example.com",
    });
    expect(html).toContain("That link didn't work");
    expect(html).toContain('role="alert"');
    expect(html).toContain('action="/auth/verify-email/resend"');
    expect(html).toContain('value="alice@example.com"');
    expect(html).toContain("Send a new link");
  });

  it("resent state confirms a fresh link and offers another resend", () => {
    const html = renderVerifyEmailPage({
      state: "resent",
      email: "alice@example.com",
    });
    expect(html).toContain('role="status"');
    expect(html).toContain("fresh verification link");
    expect(html).toContain('action="/auth/verify-email/resend"');
  });

  it("renders the resend as a primary button across the resend states", () => {
    for (const state of ["pending", "failure", "resent"] as const) {
      const html = renderVerifyEmailPage({ state, email: "alice@example.com" });
      expect(html).toContain("btn btn--primary");
    }
  });

  it("arms a 60s cooldown on the resent state's resend button only", () => {
    const resent = renderVerifyEmailPage({
      state: "resent",
      email: "alice@example.com",
    });
    // The button carries the cooldown attribute and ships the countdown script.
    expect(resent).toContain('data-cooldown="60"');
    expect(resent).toContain("button[data-cooldown]");
    // The first-view pending state has no cooldown — it hasn't been pressed yet.
    const pending = renderVerifyEmailPage({
      state: "pending",
      email: "alice@example.com",
    });
    expect(pending).not.toContain("data-cooldown");
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
