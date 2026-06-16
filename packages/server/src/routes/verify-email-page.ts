/**
 * Verify-email page renderer for `/auth/verify-email`.
 *
 * Server-rendered HTML, uses the shared auth-page layout. Four states:
 *
 *   - `pending` — no token in the URL. Shown after sign-up while the user
 *     checks their inbox. A resend affordance (a one-tap button when we
 *     already know their address, an email field otherwise).
 *   - `success` — token validated, account verified and signed in.
 *   - `failure` — token rejected (expired / already used / malformed). One
 *     plain "that link didn't work" screen with an inline resend.
 *   - `resent` — a fresh link was just sent; same resend affordance so the
 *     user can request another.
 *
 * Email pre-fill threads through `?email=` so the resend needs no typing on
 * the common "user just signed up" path.
 */

import { renderAuthLayout } from "./auth-layout.js";

export type VerifyEmailState = "pending" | "success" | "failure" | "resent";

interface VerifyEmailPageParams {
  state: VerifyEmailState;
  /** Pre-fill on the resend form. `null` when unknown — the form still
   *  renders, just with an empty field. */
  email?: string | null;
  /** `return_to` to thread through after a successful verification. */
  returnTo?: string;
}

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
  const emailKnown = (params.email ?? "").length > 0;

  // Resend with the address we already have — one tap, no typing.
  const compactResend = (label: string): string => `
    <form method="POST" action="/auth/verify-email/resend" novalidate>
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <input type="hidden" name="email" value="${safeEmail}">
      <div class="actions">
        <button type="submit" class="btn btn--oidc">${label}</button>
      </div>
    </form>
  `;

  // Resend that asks for the address (failure path, or when we don't know it).
  const fieldResend = (label: string): string => `
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
      <div class="actions">
        <button type="submit" class="btn btn--primary">${label}</button>
      </div>
    </form>
  `;

  let title: string;
  let bodyHtml: string;

  if (params.state === "success") {
    title = "Email verified";
    bodyHtml = `
      <h1 class="title">Email verified</h1>
      <p class="sub" role="status">You're all set and signed in.</p>
      <div class="actions">
        <a href="${safeReturnTo}" class="btn btn--primary">Continue</a>
      </div>
    `;
  } else if (params.state === "failure") {
    title = "That link didn't work";
    bodyHtml = `
      <h1 class="title">That link didn't work</h1>
      <p class="sub" role="alert">It may have expired or already been used. Enter your email and we'll send a fresh one.</p>
      ${fieldResend("Send a new link")}
    `;
  } else if (params.state === "resent") {
    title = "Check your email";
    bodyHtml = `
      <h1 class="title">Check your email</h1>
      <p class="sub" role="status">A fresh verification link is on its way. Open it to finish signing in.</p>
      ${emailKnown ? compactResend("Resend email") : fieldResend("Resend email")}
    `;
  } else {
    title = "Verify your email";
    bodyHtml = `
      <h1 class="title">Verify your email</h1>
      <p class="sub">Welcome to Marfa. Open the link we just emailed to finish signing in.</p>
      ${emailKnown ? compactResend("Resend email") : fieldResend("Resend email")}
    `;
  }

  return renderAuthLayout({ title, bodyHtml });
}
