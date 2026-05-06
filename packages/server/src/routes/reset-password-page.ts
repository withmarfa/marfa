/**
 * Reset-password page renderer for `/auth/reset-password`.
 *
 * Wave C PR3 / T-033. Server-rendered HTML, uses the shared auth-page
 * layout (PR4). Three states:
 *
 *   - `form` — token present + valid (or untested). Renders password
 *     + confirm fields and the hidden token round-trip.
 *   - `success` — password updated. Banner + sign-in link.
 *   - `failure` — token invalid / expired / already-used. Banner +
 *     a "Request a fresh link" link back to /auth/forgot-password.
 */

import { renderAuthLayout } from "./auth-layout.js";

export type ResetPasswordState = "form" | "success" | "failure";

interface ResetPasswordPageParams {
  state: ResetPasswordState;
  /** Single-use token from `?token=…`. Round-trips through the form
   *  as a hidden field so the POST handler can hand it to better-auth. */
  token?: string | null;
  /** `return_to` to thread through after successful reset. */
  returnTo?: string;
  /** Error code on the form re-render (e.g. user-side validation). */
  formError?: "missing_field" | "password_mismatch" | "weak_password";
  /** Failure reason — controls the failure-state banner copy. */
  failureCode?: "expired" | "invalid" | "unknown";
}

const FORM_ERROR_MESSAGES: Record<
  NonNullable<ResetPasswordPageParams["formError"]>,
  string
> = {
  missing_field: "Please fill in every field.",
  password_mismatch: "Passwords don't match. Try again.",
  weak_password: "Password must be at least 8 characters.",
};

const FAILURE_MESSAGES: Record<
  NonNullable<ResetPasswordPageParams["failureCode"]>,
  string
> = {
  expired:
    "That reset link has expired. Request a fresh one from the sign-in page.",
  invalid:
    "That reset link is invalid. Request a fresh one from the sign-in page.",
  unknown:
    "We couldn't reset your password. Request a fresh link and try again.",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the reset-password page as a complete HTML document. */
export function renderResetPasswordPage(
  params: ResetPasswordPageParams,
): string {
  const safeToken = escapeHtml(params.token ?? "");
  const safeReturnTo = escapeHtml(params.returnTo ?? "/");

  const formErrorBanner = params.formError
    ? `<div class="banner banner--error" role="alert">${escapeHtml(FORM_ERROR_MESSAGES[params.formError])}</div>`
    : "";

  const form = `
    <form method="POST" action="/auth/reset-password" class="form" novalidate>
      <input type="hidden" name="token" value="${safeToken}">
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <label class="field">
        <span class="field__label">New password</span>
        <input type="password"
               name="password"
               required
               minlength="8"
               autocomplete="new-password"
               autofocus
               aria-required="true"
               aria-describedby="password-hint">
        <span id="password-hint" class="field__hint">At least 8 characters.</span>
      </label>
      <label class="field">
        <span class="field__label">Confirm new password</span>
        <input type="password"
               name="password_confirm"
               required
               minlength="8"
               autocomplete="new-password"
               aria-required="true">
      </label>
      <button type="submit" class="btn btn--primary">Update password</button>
    </form>
  `;

  let title = "Reset your password";
  let bodyHtml: string;

  if (params.state === "success") {
    title = "Password updated";
    bodyHtml = `
      <h1>Password updated</h1>
      <div class="banner banner--success" role="status">Your password has been changed and other sessions have been signed out.</div>
      <p class="aux"><a href="/auth/sign-in?return_to=${safeReturnTo}">Sign in</a></p>
    `;
  } else if (params.state === "failure") {
    const code = params.failureCode ?? "unknown";
    bodyHtml = `
      <h1>Reset failed</h1>
      <div class="banner banner--error" role="alert">${escapeHtml(FAILURE_MESSAGES[code])}</div>
      <p class="aux"><a href="/auth/forgot-password">Request a fresh link</a></p>
    `;
  } else {
    bodyHtml = `
      <h1>Choose a new password</h1>
      <p class="lede">Enter your new password below. The reset link is single-use, so make it count.</p>
      ${formErrorBanner}
      ${form}
    `;
  }

  return renderAuthLayout({ title, bodyHtml });
}
