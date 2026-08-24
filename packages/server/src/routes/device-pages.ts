/**
 * HTML pages for the Device Authorization Grant flow (RFC 8628):
 * verification form, consent screen, and decision-result page.
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

import type { ParsedScope } from "@withmarfa/shared";
import { isCapabilityScope } from "@withmarfa/shared";
import { renderAuthLayout } from "./auth-layout.js";
import { CAPABILITY_LABELS } from "./consent.js";
import { escapeHtml, confirmIcon } from "./auth-html.js";

interface DevicePageParams {
  /** Pre-filled user_code from ?user_code=X. Optional. */
  prefilled: string;
  /** Error code from a previous attempt. */
  error?: string;
}

interface DeviceConsentParams {
  clientName: string;
  scopes: ParsedScope[];
  userCode: string;
  descriptions?: Record<string, string>;
}

interface DeviceDecisionParams {
  approved: boolean;
}

const ERROR_MESSAGES: Record<string, string> = {
  missing_code: "Enter the code shown on your other device.",
  invalid_code: "That code wasn't recognized. Check for typos and try again.",
  already_resolved:
    "That code has already been used. Restart the sign-in on your other device.",
  expired_code:
    "That code has expired. Restart the sign-in on your other device.",
  too_many_attempts:
    "Too many attempts for that code. Restart the sign-in on your other device.",
};

/**
 * Friendly, second-person labels for the standard OIDC literals. The OIDC
 * spec carries no human description, and a raw `openid` literal reads as
 * noise on a consent screen — so the device renderer owns this mapping
 * rather than depending on the caller threading one in. Kept short and
 * plain to match the tone of the type-registry descriptions.
 */
const OIDC_FRIENDLY_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "See your basic profile",
  email: "See your email address",
};

/**
 * Resolve the human-readable description for a parsed scope, deduped across
 * the full set. OIDC literals and capability scopes map to friendly labels;
 * everything else uses the caller-supplied description, falling back to the
 * scope literal. The returned order follows first appearance in `scopes`.
 *
 * The verb-less families are named rather than defaulted, because the
 * fallback is a literal this function rebuilds and the naive rebuild is
 * wrong for them. Appending `:${operation}` to a capability produces
 * `capability.webhooks:none`, which no parser accepts and nobody signed, and
 * this string is what a person reads on the device-approval screen when no
 * description resolves. Nothing is granted from it, so the failure is
 * cosmetic, but it is cosmetic on a screen whose only job is telling someone
 * what they are about to approve.
 */
/** The curated label for a scope literal, or undefined when it names no
 *  capability. Mirrors the consent screen's accessor so the device screen
 *  and the browser screen cannot describe one grant two ways. */
function capabilityLabel(literal: string): string | undefined {
  return isCapabilityScope(literal) ? CAPABILITY_LABELS[literal] : undefined;
}

function describeCapabilities(
  scopes: ParsedScope[],
  descriptions?: Record<string, string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scopes) {
    const literal =
      s.kind === "oidc" || s.kind === "capability"
        ? s.typePattern
        : `${s.typePattern}:${s.operation}`;
    const human =
      s.kind === "oidc"
        ? (OIDC_FRIENDLY_LABELS[s.oidcScope ?? s.typePattern] ?? literal)
        : s.kind === "capability"
          ? (capabilityLabel(s.typePattern) ?? literal)
          : (descriptions?.[s.typePattern] ?? literal);
    if (seen.has(human)) continue;
    seen.add(human);
    out.push(human);
  }
  return out;
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
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
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
    <script src="/auth/static/submit-state.js"></script>
    <script>${OTP_SCRIPT}</script>
  `;

  return renderAuthLayout({ title: "Sign in on your device", bodyHtml });
}

/** Renders the consent screen for an approved device-code journey. */
export function renderDeviceConsentScreen(params: DeviceConsentParams): string {
  const safeClient = escapeHtml(params.clientName);
  const safeUserCode = escapeHtml(params.userCode);

  // Friendly, deduped capability labels rendered as airy check rows — each
  // a leading check glyph, no toggle (these are confirmed, not editable).
  const capRows = describeCapabilities(params.scopes, params.descriptions)
    .map(
      (human) =>
        `<div class="crow"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>${escapeHtml(human)}</span></div>`,
    )
    .join("");

  // The code is a display (the user confirms it matches their other device),
  // not an entry input — show it whole in a soft code tile.
  const bodyHtml = `
    <h1 class="title">Approve sign-in</h1>
    <p class="sub"><b>${safeClient}</b> is trying to sign in as you. Approve only if this code matches what's on that device.</p>
    <div class="codetile">${safeUserCode}</div>
    <div style="margin-top:10px">
      ${capRows}
    </div>
    <div class="actions">
      <form method="POST" action="/auth/device/consent" novalidate>
        <input type="hidden" name="user_code" value="${safeUserCode}">
        <input type="hidden" name="decision" value="approve">
        <button type="submit" class="btn btn--primary" data-loading-label="Approving...">Approve</button>
      </form>
      <form method="POST" action="/auth/device/consent" novalidate>
        <input type="hidden" name="user_code" value="${safeUserCode}">
        <input type="hidden" name="decision" value="deny">
        <button type="submit" class="btn btn--ghost">Deny</button>
      </form>
    </div>
    <script src="/auth/static/submit-state.js"></script>
  `;

  return renderAuthLayout({
    title: "Approve device sign-in",
    bodyHtml,
  });
}

/** Renders the result page after the user approves or denies. */
export function renderDeviceDecisionPage(params: DeviceDecisionParams): string {
  const heading = params.approved
    ? "You're signed in"
    : "You denied the request";
  const sub = params.approved
    ? "You can return to your other device. It will pick up the sign-in shortly."
    : "Your other device won't be granted access. You can close this window.";

  const bodyHtml = `
    ${confirmIcon(params.approved ? "check" : "alert")}
    <h1 class="title">${escapeHtml(heading)}</h1>
    <p class="sub" role="status">${escapeHtml(sub)}</p>
  `;

  return renderAuthLayout({ title: heading, bodyHtml, centered: true });
}
