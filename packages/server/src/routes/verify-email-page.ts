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
 *   - `resent` — a fresh link was just sent; same resend affordance, but the
 *     resend button starts in a 60-second cooldown so the user can't hammer
 *     the send.
 *
 * Email pre-fill threads through `?email=` so the resend needs no typing on
 * the common "user just signed up" path.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml, confirmIcon } from "./auth-html.js";

export type VerifyEmailState = "pending" | "success" | "failure" | "resent";

/**
 * Countdown for the resent-state resend button. Reads `data-cooldown` (seconds)
 * off the button, disables it, and ticks the label down ("Resend in 59s", …)
 * before restoring the original label and re-enabling. Carries no interpolated
 * values, so it needs no escaping.
 */
const RESEND_COOLDOWN_SCRIPT = `
(function () {
  var btns = document.querySelectorAll('button[data-cooldown]');
  for (var i = 0; i < btns.length; i++) {
    (function (btn) {
      var secs = parseInt(btn.getAttribute('data-cooldown'), 10) || 60;
      var label = btn.textContent;
      btn.disabled = true;
      (function tick() {
        if (secs <= 0) { btn.disabled = false; btn.textContent = label; return; }
        btn.textContent = 'Resend in ' + secs + 's';
        secs -= 1;
        setTimeout(tick, 1000);
      })();
    })(btns[i]);
  }
})();
`.trim();

interface VerifyEmailPageParams {
  state: VerifyEmailState;
  /** Pre-fill on the resend form. `null` when unknown — the form still
   *  renders, just with an empty field. */
  email?: string | null;
  /** `return_to` to thread through after a successful verification. */
  returnTo?: string;
}

/** Renders the verify-email page as a complete HTML document string. */
export function renderVerifyEmailPage(params: VerifyEmailPageParams): string {
  const safeEmail = escapeHtml(params.email ?? "");
  const safeReturnTo = escapeHtml(params.returnTo ?? "/");
  const emailKnown = (params.email ?? "").length > 0;

  // Resend the verification email is the primary action on this surface, so
  // its button is the filled primary everywhere it appears. The `cooldown`
  // flag (set on the post-send `resent` state) starts it disabled with a
  // 60-second countdown so a user can't hammer the send.
  const cooldownAttr = (cooldown: boolean): string =>
    cooldown ? ' data-cooldown="60"' : "";

  // Resend with the address we already have — one tap, no typing. The form is
  // itself the `.actions` block, so the button sits a single step below the
  // body copy (uniform with the other screens).
  const compactResend = (label: string, cooldown: boolean): string => `
    <form method="POST" action="/auth/verify-email/resend" class="actions" novalidate>
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <input type="hidden" name="email" value="${safeEmail}">
      <button type="submit" class="btn btn--primary" data-loading-label="Sending..."${cooldownAttr(cooldown)}>${label}</button>
    </form>
  `;

  // Resend that asks for the address (failure path, or when we don't know it).
  const fieldResend = (label: string, cooldown: boolean): string => `
    <form method="POST" action="/auth/verify-email/resend" class="form" novalidate>
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
      <div class="actions">
        <button type="submit" class="btn btn--primary" data-loading-label="Sending..."${cooldownAttr(cooldown)}>${label}</button>
      </div>
    </form>
  `;

  let title: string;
  let bodyHtml: string;

  if (params.state === "success") {
    title = "Email verified";
    bodyHtml = `
      ${confirmIcon("check")}
      <h1 class="title">Email verified</h1>
      <p class="sub" role="status">You're all set and signed in.</p>
      <div class="actions">
        <a href="${safeReturnTo}" class="btn btn--primary">Continue</a>
      </div>
    `;
  } else if (params.state === "failure") {
    title = "That link didn't work";
    bodyHtml = `
      ${confirmIcon("alert")}
      <h1 class="title">That link didn't work</h1>
      <p class="sub" role="alert">It may have expired or already been used. Enter your email and we'll send a fresh one.</p>
      ${fieldResend("Send a new link", false)}
    `;
  } else if (params.state === "resent") {
    title = "Check your email";
    bodyHtml = `
      ${confirmIcon("mail")}
      <h1 class="title">Check your email</h1>
      <p class="sub" role="status">A fresh verification link is on its way. Open it to finish signing in.</p>
      ${emailKnown ? compactResend("Resend email", true) : fieldResend("Resend email", true)}
    `;
  } else {
    title = "Verify your email";
    bodyHtml = `
      ${confirmIcon("mail")}
      <h1 class="title">Verify your email</h1>
      <p class="sub">Welcome to Marfa. Open the link we just emailed to finish signing in.</p>
      ${emailKnown ? compactResend("Resend email", false) : fieldResend("Resend email", false)}
    `;
  }

  // The success state is link-only; every other state carries a resend form
  // that benefits from the submitting-state guard.
  if (params.state !== "success") {
    bodyHtml += `\n    <script src="/auth/static/submit-state.js"></script>`;
  }
  // The resent state arms a 60s cooldown on its resend button (data-cooldown);
  // this tiny inline script runs the countdown. No-JS clients just see an
  // enabled "Resend email" button.
  if (params.state === "resent") {
    bodyHtml += `\n    <script>${RESEND_COOLDOWN_SCRIPT}</script>`;
  }

  return renderAuthLayout({ title, bodyHtml, centered: true });
}
