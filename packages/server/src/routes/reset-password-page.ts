/**
 * Reset-password page renderer for `/auth/reset-password`.
 *
 * Server-rendered HTML, uses the shared auth-page layout. Three states:
 *
 *   - `form` — token present + valid (or untested). Renders password
 *     + confirm fields and the hidden token round-trip.
 *   - `success` — password updated. Sign-in link.
 *   - `failure` — token invalid / expired / already-used. One plain
 *     "that link didn't work" screen with a way back to request a fresh
 *     link from /auth/forgot-password.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

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
}

const FORM_ERROR_MESSAGES: Record<
  NonNullable<ResetPasswordPageParams["formError"]>,
  string
> = {
  missing_field: "Please fill in every field.",
  password_mismatch: "Passwords don't match. Try again.",
  weak_password: "Password must be at least 8 characters.",
};

/** Renders the reset-password page as a complete HTML document. */
export function renderResetPasswordPage(
  params: ResetPasswordPageParams,
): string {
  const safeToken = escapeHtml(params.token ?? "");
  const safeReturnTo = escapeHtml(params.returnTo ?? "/");

  // The reset errors are all password-related, so they render under the
  // password field rather than in a top banner.
  const formError = params.formError;
  const fieldError = formError
    ? `<span class="field__error" role="alert">${escapeHtml(FORM_ERROR_MESSAGES[formError])}</span>`
    : "";

  const form = `
    <form method="POST" action="/auth/reset-password" class="form" novalidate>
      <input type="hidden" name="token" value="${safeToken}">
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <label class="field${formError ? " field--error" : ""}">
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
        ${fieldError}
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
      <div class="actions">
        <button type="submit" class="btn btn--primary" data-loading-label="Updating password...">Update password</button>
      </div>
    </form>
  `;

  let title: string;
  let bodyHtml: string;

  if (params.state === "success") {
    title = "Password updated";
    bodyHtml = `
      <h1 class="title">Password updated</h1>
      <p class="sub" role="status">Your password is changed and your other sessions are signed out.</p>
      <div class="actions">
        <a href="/auth/sign-in?return_to=${safeReturnTo}" class="btn btn--primary">Sign in</a>
      </div>
    `;
  } else if (params.state === "failure") {
    title = "That link didn't work";
    bodyHtml = `
      <h1 class="title">That link didn't work</h1>
      <p class="sub" role="alert">It may have expired or already been used. Request a fresh reset link.</p>
      <div class="actions">
        <a href="/auth/forgot-password" class="btn btn--primary">Request a fresh link</a>
      </div>
    `;
  } else {
    title = "Set a new password";
    bodyHtml = `
      <h1 class="title">Set a new password</h1>
      <p class="sub">Choose a new password for your account.</p>
      ${form}
      <script src="/auth/static/password-toggle.js"></script>
      <script src="/auth/static/submit-state.js"></script>
    `;
  }

  return renderAuthLayout({ title, bodyHtml });
}
