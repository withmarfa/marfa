import { authAssetUrl } from "./auth-static.js";
/**
 * The page where a person types the code a device showed them (RFC 8628).
 * The approval screen and the page that ends it are in `device-approval.tsx`.
 *
 * Same minimalist scaffolding as sign-in / sign-up — server-rendered,
 * no client-side framework. The verification page accepts an optional
 * `user_code` query param to pre-fill the form (so the
 * `verification_uri_complete` link the CLI prints can land the user
 * directly at consent).
 *
 * Pages reference the shared stylesheet at `/auth/static/auth.css`
 * via the `renderAuthLayout` helper.
 */

import { waitInMinutes } from "../pages/lockout.js";
import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

interface DevicePageParams {
  /** Pre-filled user_code from ?user_code=X. Optional. */
  prefilled: string;
  /** Error code from a previous attempt. */
  error?: string;
  /** The whole seconds until another attempt will be allowed, from the
   *  `retry_after` the server redirected with. */
  retryAfter?: number;
  /** The nonce the response's content security policy names, which the
   *  inline script carries. */
  nonce: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  missing_code: "Enter the code shown on your other device.",
  invalid_code: "That code wasn't recognized. Check for typos and try again.",
  already_resolved:
    "That code has already been used. Restart the sign-in on your other device.",
  expired_code:
    "That code has expired. Restart the sign-in on your other device.",
  another_account:
    "That code was started under a different account. Sign in as that account, or restart the sign-in on your other device.",
};

/** What a code lookup refused by a limit says: the wait, when the server gave one. */
function tooManyCodesMessage(retryAfter: number | undefined): string {
  return retryAfter === undefined
    ? "Too many codes have been tried. Try again later."
    : `Too many codes have been tried. Try again in ${waitInMinutes(retryAfter)}.`;
}

/**
 * Enhances the single code input into segmented one-time-code cells. The real
 * input stays in the form (hidden) and still carries the submitted value, so the
 * no-JavaScript path is a normal single field. A filled cell takes the soft tile
 * fill via `.otp__cell--filled`. Carries no interpolated values, so no escaping.
 */
const OTP_SCRIPT = `
(function () {
  var form = document.querySelector('[data-otp-form]');
  if (!form) return;
  var real = form.querySelector('[data-otp-input]');
  var box = form.querySelector('[data-otp]');
  if (!real || !box) return;
  var N = 8;
  var cells = [];
  for (var i = 0; i < N; i++) {
    if (i === 4) {
      var dash = document.createElement('span');
      dash.className = 'otp__dash';
      dash.textContent = '-';
      box.appendChild(dash);
    }
    var c = document.createElement('input');
    c.className = 'otp__cell';
    c.type = 'text';
    c.inputMode = 'text';
    c.autocapitalize = 'characters';
    c.autocomplete = i === 0 ? 'one-time-code' : 'off';
    c.setAttribute('aria-label', 'Character ' + (i + 1));
    c.maxLength = 1;
    cells.push(c);
    box.appendChild(c);
  }
  function focusCell(i) { if (i >= 0 && i < N) cells[i].focus(); }
  function sync() {
    var a = '', b = '';
    for (var i = 0; i < N; i++) {
      var v = cells[i].value;
      cells[i].classList.toggle('otp__cell--filled', v !== '');
      if (i < 4) a += v; else b += v;
    }
    real.value = b ? a + '-' + b : a;
  }
  cells.forEach(function (c, i) {
    c.addEventListener('input', function () {
      c.value = c.value.toUpperCase().slice(0, 1);
      sync();
      if (c.value) focusCell(i + 1);
    });
    c.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !c.value) focusCell(i - 1);
      else if (e.key === 'ArrowLeft') { e.preventDefault(); focusCell(i - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); focusCell(i + 1); }
    });
    c.addEventListener('focus', function () { c.select(); });
    c.addEventListener('paste', function (e) {
      e.preventDefault();
      var data = e.clipboardData || window.clipboardData;
      var text = data ? data.getData('text') : '';
      var chars = (text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').split('');
      for (var k = 0; k < chars.length && i + k < N; k++) cells[i + k].value = chars[k];
      sync();
      focusCell(Math.min(i + chars.length, N - 1));
    });
  });
  var seed = (real.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').split('');
  for (var j = 0; j < seed.length && j < N; j++) cells[j].value = seed[j];
  sync();
  real.hidden = true;
  real.setAttribute('tabindex', '-1');
  box.hidden = false;
  focusCell(seed.length < N ? seed.length : N - 1);
})();
`.trim();

/** Renders the verification form where the user types the user_code. */
export function renderDevicePage(params: DevicePageParams): string {
  const errorMessage = params.error
    ? params.error === "too_many_attempts"
      ? tooManyCodesMessage(params.retryAfter)
      : (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
    : null;
  // Single-field form, so the error renders under the code input.
  const hasError = errorMessage !== null;
  const fieldError = hasError
    ? `<span class="field__error" role="alert">${escapeHtml(errorMessage)}</span>`
    : "";
  const safePrefilled = escapeHtml(params.prefilled);

  const bodyHtml = `
    <h1 class="title">Sign in on your device</h1>
    <p class="sub">Enter the code shown on your other device.</p>
    <form method="POST" action="/auth/device" class="form" novalidate data-otp-form>
      <label class="field${hasError ? " field--error" : ""}">
        <span class="field__label">Code</span>
        <input type="text"
               class="field__input--code"
               name="user_code"
               value="${safePrefilled}"
               placeholder="XXXX-XXXX"
               required
               autocomplete="off"
               autocorrect="off"
               autocapitalize="characters"
               spellcheck="false"
               autofocus
               maxlength="9"
               aria-required="true"
               data-otp-input>
        <div class="otp" data-otp hidden aria-hidden="true"></div>
        ${fieldError}
      </label>
      <div class="actions">
        <button type="submit" class="btn btn--primary" data-loading-label="Checking...">Continue</button>
      </div>
    </form>
    <script src="${authAssetUrl("submit-state.js")}" nonce="${escapeHtml(params.nonce)}"></script>
    <script nonce="${escapeHtml(params.nonce)}">${OTP_SCRIPT}</script>
  `;

  return renderAuthLayout({
    title: "Sign in on your device",
    bodyHtml,
    nonce: params.nonce,
  });
}
