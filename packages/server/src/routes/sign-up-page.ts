/**
 * Sign-up page renderer for the human-facing /auth/sign-up surface.
 *
 * Server-rendered HTML, no client-side framework. Posts to the wrapper
 * handler (`POST /auth/sign-up`) which dispatches to Better Auth's JSON
 * API (`POST /auth/sign-up/email`) and translates the response back to
 * a 302 redirect.
 *
 * Conditional surface — the GET handler returns 404 when
 * `MARFA_AUTH_ALLOW_SIGNUP=false`. Single-user self-hosted instances
 * flip the flag on for the initial admin account, then back off.
 *
 * Two post-sign-up paths depending on whether email verification is on:
 *   - Verification off — `autoSignIn` sets a session cookie immediately
 *     and the user lands on `return_to` already authenticated.
 *   - Verification on (`requireEmailVerification: true`) — Better Auth
 *     skips auto-sign-in and the wrapper handler 302s to
 *     `/auth/verify-email` instead, where the user clicks the emailed
 *     link before they can sign in.
 *
 * References the shared stylesheet at `/auth/static/auth.css` via
 * the `renderAuthLayout` helper; no inline `<style>` block.
 */

import { renderAuthLayout } from "./auth-layout.js";

interface SignUpPageParams {
  /** Where to send the user after a successful sign-up. Validated by
   *  the caller — only relative paths starting with `/` are accepted. */
  returnTo: string;
  /** Error code from a previous attempt. Renders an inline banner. */
  error?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  missing_field: "Please fill in every field.",
  password_mismatch: "Passwords don't match. Try again.",
  weak_password: "Password must be at least 8 characters.",
  email_invalid: "That doesn't look like a valid email address.",
  email_exists: "An account with that email already exists. Sign in instead.",
  signup_failed: "Couldn't create the account. Try again.",
  // Username (handle) error messages.
  handle_invalid:
    "Usernames must be 3-32 lowercase letters, numbers, or hyphens (no leading/trailing hyphens).",
  handle_reserved: "That username is reserved. Try another.",
  handle_taken: "That username is already taken. Try another.",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the sign-up page as a complete HTML document string. */
export function renderSignUpPage(params: SignUpPageParams): string {
  const safeReturnTo = escapeHtml(params.returnTo);

  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
    : null;

  const errorBanner = errorMessage
    ? `<div class="banner banner--error" role="alert">${escapeHtml(errorMessage)}</div>`
    : "";

  const signInHref = `/auth/sign-in?${escapeHtml(buildQuery({ return_to: params.returnTo }))}`;

  const bodyHtml = `
    <h1>Create your Marfa account</h1>
    ${errorBanner}
    <form method="POST" action="/auth/sign-up" class="form" novalidate>
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <label class="field">
        <span class="field__label">Email</span>
        <input type="email"
               name="email"
               required
               autocomplete="email"
               autofocus
               aria-required="true">
      </label>
      <label class="field">
        <span class="field__label">Display name</span>
        <input type="text"
               name="name"
               required
               autocomplete="name"
               aria-required="true">
      </label>
      <label class="field">
        <span class="field__label">Username</span>
        <input type="text"
               name="username"
               required
               pattern="[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?"
               minlength="3"
               maxlength="32"
               autocomplete="username"
               autocapitalize="none"
               spellcheck="false"
               aria-required="true"
               aria-describedby="username-hint">
        <span id="username-hint" class="field__hint">Lowercase letters, numbers, hyphens. 3–32 characters. Public — used as your handle on Marfa.</span>
      </label>
      <label class="field">
        <span class="field__label">Password</span>
        <input type="password"
               name="password"
               required
               minlength="8"
               autocomplete="new-password"
               aria-required="true"
               aria-describedby="password-hint">
        <span id="password-hint" class="field__hint">At least 8 characters.</span>
      </label>
      <label class="field">
        <span class="field__label">Confirm password</span>
        <input type="password"
               name="password_confirm"
               required
               minlength="8"
               autocomplete="new-password"
               aria-required="true">
      </label>
      <button type="submit" class="btn btn--primary">Create account</button>
    </form>
    <p class="aux">Already have an account? <a href="${signInHref}">Sign in</a></p>
  `;

  return renderAuthLayout({
    title: "Create your Marfa account",
    bodyHtml,
  });
}

/** Build a URL-encoded query string. Only includes truthy values. */
function buildQuery(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value)
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}
