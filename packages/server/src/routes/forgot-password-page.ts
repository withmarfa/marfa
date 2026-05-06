/**
 * Forgot-password page renderer for `/auth/forgot-password`.
 *
 * Wave C PR3 / T-033. Server-rendered HTML, uses the shared auth-page
 * layout (PR4). Three states:
 *
 *   - `form` — initial render. Single email field, submit button,
 *     "Sign in instead" link.
 *   - `sent` — soft-fail success: "If an account exists for X, we've
 *     sent a password-reset link". Identical copy regardless of
 *     whether the address actually has an account, to prevent
 *     enumeration.
 *   - `error` — render with an error banner (rare; rate-limit and
 *     misconfigured-backend are the main paths).
 */

import { renderAuthLayout } from "./auth-layout.js";

export type ForgotPasswordState = "form" | "sent" | "error";

interface ForgotPasswordPageParams {
  state: ForgotPasswordState;
  /** Pre-fill on the form / echoed back on the success message. */
  email?: string | null;
  /** Where to send the user after a successful sign-in (post-reset).
   *  Threaded through the email URL so the reset-password page can
   *  redirect appropriately. Validated by the caller. */
  returnTo?: string;
  /** Error code from a previous attempt — `rate_limited`,
   *  `email_not_configured`, `unknown`. */
  errorCode?: "rate_limited" | "email_not_configured" | "unknown";
}

const ERROR_MESSAGES: Record<
  NonNullable<ForgotPasswordPageParams["errorCode"]>,
  string
> = {
  rate_limited:
    "Too many reset requests. Wait a few minutes before trying again.",
  email_not_configured:
    "Password reset isn't available on this server. Contact your operator.",
  unknown: "Something went wrong. Try again in a moment.",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the forgot-password page as a complete HTML document. */
export function renderForgotPasswordPage(
  params: ForgotPasswordPageParams,
): string {
  const safeEmail = escapeHtml(params.email ?? "");
  const safeReturnTo = escapeHtml(params.returnTo ?? "/");

  const form = `
    <form method="POST" action="/auth/forgot-password" class="form" novalidate>
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <label class="field">
        <span class="field__label">Email</span>
        <input type="email"
               name="email"
               value="${safeEmail}"
               required
               autocomplete="email"
               autofocus
               aria-required="true">
      </label>
      <button type="submit" class="btn btn--primary">Send reset link</button>
    </form>
    <p class="aux">Remembered it? <a href="/auth/sign-in">Sign in</a></p>
  `;

  const errorBanner =
    params.state === "error" && params.errorCode
      ? `<div class="banner banner--error" role="alert">${escapeHtml(ERROR_MESSAGES[params.errorCode])}</div>`
      : "";

  const bodyHtml =
    params.state === "sent"
      ? `
      <h1>Check your inbox</h1>
      <div class="banner banner--success" role="status">If an account exists${
        params.email ? ` for ${escapeHtml(params.email)}` : ""
      }, we've sent a password-reset link. It expires in an hour.</div>
      <p class="lede">Didn't get one? You can request another below.</p>
      ${form}
    `
      : `
      <h1>Reset your password</h1>
      <p class="lede">Enter your email and we'll send you a link to choose a new password.</p>
      ${errorBanner}
      ${form}
    `;

  return renderAuthLayout({
    title: params.state === "sent" ? "Check your inbox" : "Reset your password",
    bodyHtml,
  });
}
