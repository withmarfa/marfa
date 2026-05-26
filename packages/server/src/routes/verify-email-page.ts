/**
 * Verify-email page renderer for `/auth/verify-email`.
 *
 * Wave C PR2. Server-rendered HTML, uses the shared auth-page layout
 * (PR4). Three states:
 *
 *   - `pending` — no token in the URL (or empty). Shown after sign-up
 *     while the user goes to check their inbox. Optional resend form.
 *   - `success` — token validated, account verified. Renders a
 *     "you're signed in" confirmation. Cookie has been set by the
 *     verify-email API call upstream.
 *   - `failure` — token rejected (expired / invalid / already-used).
 *     Renders a resend form so the user can request a fresh email.
 *   - `resent` — resend succeeded. Renders a banner; same shape as
 *     `pending` so the user can resend again if needed.
 *
 * Email pre-fill threads through `?email=` so the resend form needs
 * no typing on the common "user just signed up" path.
 */

import { renderAuthLayout } from "./auth-layout.js";

export type VerifyEmailState = "pending" | "success" | "failure" | "resent";

interface VerifyEmailPageParams {
  state: VerifyEmailState;
  /** Pre-fill on the resend form. `null` when unknown — the form still
   *  renders, just empty. */
  email?: string | null;
  /** `return_to` to thread through after a successful verification. */
  returnTo?: string;
  /** Failure reason — controls the failure-state banner copy. */
  failureCode?: "expired" | "invalid" | "unknown";
}

const FAILURE_MESSAGES: Record<
  NonNullable<VerifyEmailPageParams["failureCode"]>,
  string
> = {
  expired:
    "That verification link has expired. Request a new one and try again.",
  invalid:
    "That verification link is invalid. Request a new one and try again.",
  unknown: "We couldn't verify your email. Request a new link and try again.",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the verify-email page as a complete HTML document string. */
export function renderVerifyEmailPage(params: VerifyEmailPageParams): string {
  const safeEmail = escapeHtml(params.email ?? "");
  const safeReturnTo = escapeHtml(params.returnTo ?? "/");

  const resendForm = `
    <form method="POST" action="/auth/verify-email/resend" class="form" novalidate>
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <label class="field">
        <span class="field__label">Email</span>
        <input type="email"
               name="email"
               value="${safeEmail}"
               required
               autocomplete="email"
               aria-required="true">
      </label>
      <button type="submit" class="btn btn--primary">Resend verification email</button>
    </form>
  `;

  const title =
    params.state === "success" ? "Email verified" : "Verify your email";

  const bodyHtml =
    params.state === "success"
      ? `
      <h1>Email verified</h1>
      <div class="banner banner--success" role="status">Your email is confirmed and you're signed in.</div>
      <p class="aux"><a href="${safeReturnTo}">Continue</a></p>
    `
      : params.state === "failure"
        ? (() => {
            const code = params.failureCode ?? "unknown";
            const message = FAILURE_MESSAGES[code];
            return `
      <h1>Verification failed</h1>
      <div class="banner banner--error" role="alert">${escapeHtml(message)}</div>
      <p class="lede">Enter your email below and we'll send a fresh verification link.</p>
      ${resendForm}
    `;
          })()
        : params.state === "resent"
          ? `
      <h1>Verify your email</h1>
      <div class="banner banner--success" role="status">A fresh verification email is on its way. Check your inbox.</div>
      <p class="lede">Didn't get it? You can request another below.</p>
      ${resendForm}
    `
          : `
      <h1>Verify your email</h1>
      <p class="lede">Welcome to Marfa. We've sent a verification email — click the link inside to finish signing in.</p>
      <p class="lede">Didn't get it? You can request another below.</p>
      ${resendForm}
    `;

  return renderAuthLayout({ title, bodyHtml });
}
