/**
 * Forgot-password page renderer for `/auth/forgot-password`.
 *
 * Server-rendered HTML, uses the shared auth-page layout. Three states:
 *
 *   - `form` — initial render. Single email field, submit button,
 *     "Sign in instead" link.
 *   - `sent` — soft-fail confirmation: "If an account exists for X, a
 *     reset link is on its way". Identical copy regardless of whether the
 *     address actually has an account, to prevent enumeration.
 *   - `error` — render with an error banner (rare; rate-limit and
 *     misconfigured-backend are the main paths).
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

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

/** Renders the forgot-password page as a complete HTML document. */
export function renderForgotPasswordPage(
  params: ForgotPasswordPageParams,
): string {
  const safeEmail = escapeHtml(params.email ?? "");
  const safeReturnTo = escapeHtml(params.returnTo ?? "/");

  // Sent confirmation — its own focused screen. The soft-fail copy never
  // reveals whether the address has an account.
  if (params.state === "sent") {
    const forWhom = params.email ? ` for ${escapeHtml(params.email)}` : "";
    return renderAuthLayout({
      title: "Check your email",
      bodyHtml: `
        <h1 class="title">Check your email</h1>
        <p class="sub" role="status">If an account exists${forWhom}, a password-reset link is on its way. It expires in an hour.</p>
        <p class="aux">Wrong email? <a href="/auth/forgot-password">Try again</a></p>
      `,
    });
  }

  // Single-field form, so the error renders under the email input rather than
  // in a top banner.
  const errorCode = params.state === "error" ? params.errorCode : undefined;
  const fieldError = errorCode
    ? `<span class="field__error" role="alert">${escapeHtml(ERROR_MESSAGES[errorCode])}</span>`
    : "";

  return renderAuthLayout({
    title: "Reset your password",
    bodyHtml: `
      <h1 class="title">Reset your password</h1>
      <p class="sub">We'll email you a link to set a new password.</p>
      <form method="POST" action="/auth/forgot-password" class="form" novalidate>
        <input type="hidden" name="return_to" value="${safeReturnTo}">
        <label class="field${errorCode ? " field--error" : ""}">
          <span class="field__label">Email</span>
          <input type="email"
                 name="email"
                 value="${safeEmail}"
                 required
                 autocomplete="email"
                 autofocus
                 aria-required="true">
          ${fieldError}
        </label>
        <div class="actions">
          <button type="submit" class="btn btn--primary" data-loading-label="Sending link...">Send reset link</button>
        </div>
      </form>
      <p class="aux">Remembered it? <a href="/auth/sign-in">Sign in</a></p>
      <script src="/auth/static/submit-state.js"></script>
    `,
  });
}
