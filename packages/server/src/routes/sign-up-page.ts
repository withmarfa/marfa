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

/**
 * Inline progressive-enhancement script. The server renders both panels
 * visible; this script (when JS runs) collapses to step 1 and wires the
 * Continue/Back buttons. No-JS users keep a single, fully-visible form.
 *
 * Continue runs native HTML5 validity on the step-1 fields before
 * advancing so a user can't tab past an empty required field; the real
 * submit lives on the step-2 "Create account" button and posts every
 * field — both panels' inputs share one form, so the two-step split is
 * presentation only.
 *
 * Carries no interpolated values, so it needs no escaping.
 */
const STEP_SCRIPT = `
(function () {
  var form = document.querySelector('[data-signup-form]');
  if (!form) return;
  var steps = document.querySelector('[data-steps]');
  var title = document.querySelector('[data-title]');
  var sub = document.querySelector('[data-sub]');
  var panel1 = form.querySelector('[data-panel="1"]');
  var panel2 = form.querySelector('[data-panel="2"]');
  var next = form.querySelector('[data-next]');
  var create = form.querySelector('[data-create]');
  var back = form.querySelector('[data-back]');
  var segs = steps ? steps.querySelectorAll('.steps__seg') : [];

  function show(step) {
    panel1.style.display = step === 1 ? 'flex' : 'none';
    panel2.style.display = step === 2 ? 'flex' : 'none';
    next.style.display = step === 1 ? 'inline-flex' : 'none';
    create.style.display = step === 2 ? 'inline-flex' : 'none';
    back.style.display = step === 2 ? 'inline-flex' : 'none';
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('steps__seg--on', i < step);
    }
    if (title) {
      title.textContent =
        step === 1 ? 'Create your Marfa account' : 'Choose a password';
    }
    if (sub) {
      sub.textContent =
        step === 1
          ? 'Tell us who you are.'
          : 'One last step to secure your account.';
    }
  }

  next.addEventListener('click', function () {
    var fields = panel1.querySelectorAll('input');
    for (var i = 0; i < fields.length; i++) {
      if (!fields[i].reportValidity()) return;
    }
    show(2);
    var first = panel2.querySelector('input');
    if (first) first.focus();
  });
  back.addEventListener('click', function () {
    show(1);
  });

  show(1);
})();
`;

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

  // Two-step presentation is purely client-side. Both steps' inputs live in
  // a single <form> and submit in one POST — the split only governs which
  // panel is visible. With JS disabled the inline script never runs, so both
  // panels stay visible and the form remains a working single-page sign-up
  // (the Continue/Back buttons inert, the real submit button always present).
  const bodyHtml = `
    <div class="steps" data-steps aria-hidden="true">
      <span class="steps__seg steps__seg--on" data-seg="1"></span>
      <span class="steps__seg" data-seg="2"></span>
    </div>
    <h1 class="title" data-title>Create your Marfa account</h1>
    <p class="sub" data-sub>Tell us who you are.</p>
    ${errorBanner}
    <form method="POST" action="/auth/sign-up" class="form" novalidate data-signup-form>
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <div class="form" data-panel="1">
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
      </div>
      <div class="form" data-panel="2">
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
      </div>
      <div class="actions">
        <button type="button" class="btn btn--primary" data-next>Continue</button>
        <button type="submit" class="btn btn--primary" data-create>Create account</button>
        <button type="button" class="btn btn--ghost" data-back>Back</button>
      </div>
    </form>
    <p class="aux">Already have an account? <a href="${signInHref}">Sign in</a></p>
    <script>${STEP_SCRIPT}</script>
  `;

  return renderAuthLayout({
    title: "Create your Marfa account",
    bodyHtml,
    wide: true,
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
