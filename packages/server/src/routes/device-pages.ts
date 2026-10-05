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

import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import {
  grantCoversScope,
  HIDDEN_MECHANISM_SCOPES,
  requiresExplicitConsent,
  scopesOfferedOffByDefaultOnly,
} from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import { renderAuthLayout } from "./auth-layout.js";
import { labelFor } from "./consent.js";
import { escapeHtml, confirmIcon, unverifiedAppCallout } from "./auth-html.js";
import { isOpenEnded, OPEN_ENDED_LINE } from "./scope-openness.js";

interface DevicePageParams {
  /** Pre-filled user_code from ?user_code=X. Optional. */
  prefilled: string;
  /** Error code from a previous attempt. */
  error?: string;
}

interface DeviceConsentParams {
  clientName: string;
  /**
   * The app registered itself, so its name is whatever it said. Shown as the
   * same caution the browser consent screen carries, because the device flow
   * is where a code from a stranger is likeliest to be typed in.
   */
  unverified?: boolean;
  scopes: ParsedScope[];
  userCode: string;
  descriptions?: Record<string, string>;
  /**
   * The bundle set this instance offers, so a scope only an off-by-default
   * bundle names renders unticked here as it does on the authorize screen.
   * Absent, the instance-wide active bundles apply.
   */
  bundles?: PermissionBundle[];
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
    "Too many codes have been tried. Wait a few minutes and try again.",
  another_account:
    "That code was started under a different account. Sign in as that account, or restart the sign-in on your other device.",
};

/**
 * The literal a scope row submits, which is what the person grants by ticking
 * it.
 *
 * The verb-less families are named rather than defaulted, because appending
 * `:${operation}` to a permission produces `webhooks.manage:none`, which no
 * parser accepts.
 */
function scopeLiteral(s: ParsedScope): string {
  return s.kind === "oidc" || s.kind === "permission"
    ? s.typePattern
    : `${s.typePattern}:${s.operation}`;
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

/**
 * Renders the consent screen for an approved device-code journey.
 *
 * **The rows are toggles, and that is a change of kind rather than of
 * styling.** They were check glyphs and the copy called them confirmed rather
 * than editable, so the only decisions this screen offered were approve
 * everything and deny. That was survivable while every scope reaching it was
 * one an on-by-default bundle offered, and it stopped being survivable the
 * moment a permission could be requested: the authorize screen unticks
 * one deliberately, and a person meeting this screen instead granted it on a
 * single click. Two surfaces cannot hold opposite opinions about
 * administrative authority.
 *
 * **The alternative was refusing those scopes at initiation, and it is a
 * lockout rather than a guard.** The CLI signs in through the device flow and
 * nothing else, and the MCP server has no consent surface at all — it reads
 * the token the CLI stored. So this screen is the only door either will ever
 * reach, and refusing here would leave them permanently unable to hold a
 * permission. The refusal existed because the screen could not express
 * withholding; giving it a tick removes the premise, so the refusal is
 * retired rather than weakened.
 *
 * The tick rule is `requiresExplicitConsent` plus the bundle's own
 * `default_on`, read at this call site rather than inherited, which is the
 * standing convention for this pair of screens.
 */
export function renderDeviceConsentScreen(params: DeviceConsentParams): string {
  const safeClient = escapeHtml(params.clientName);
  const safeUserCode = escapeHtml(params.userCode);

  const bundles = params.bundles ?? getPermissionBundles();
  // Asked as coverage, not as membership, and the difference is the whole
  // of an earlier defect. The withheld set holds literals while a request
  // may be a wildcard, so `has(literal)` let `core.*:write` arrive ticked
  // while covering every withheld literal beneath it. The question is
  // whether the requested scope REACHES something withheld, which is
  // `grantCoversScope` with its arguments the way round they are here.
  const offByDefaultOnly = [...scopesOfferedOffByDefaultOnly(bundles)];
  const reachesWithheld = (literal: string): boolean =>
    offByDefaultOnly.some((withheld) => grantCoversScope([literal], withheld));

  // `openid` and `offline_access` are how a client gets an identity and a
  // refresh token rather than data permissions, so they ride along as hidden
  // checked fields exactly as they do on the authorize screen. A person
  // cannot decline a control they cannot see, so `default_on` never governed
  // them on either surface — and dropping them here would hand the CLI a
  // session it cannot renew.
  const hiddenLiterals = new Set<string>(HIDDEN_MECHANISM_SCOPES);

  const visible: string[] = [];
  const hidden: string[] = [];
  const seenLiterals = new Set<string>();
  const seenLines = new Set<string>();
  for (const scope of params.scopes) {
    const literal = scopeLiteral(scope);
    // Deduped on the literal rather than on the rendered line, because the
    // line is display and the literal is what gets submitted: two rows
    // carrying one literal would let a person untick a permission that the
    // other row grants back.
    if (seenLiterals.has(literal)) continue;
    seenLiterals.add(literal);
    const safeLiteral = escapeHtml(literal);
    // The authorize screen's own row label, so one grant reads the same on
    // both screens a person meets it on.
    const human = labelFor(scope, params.descriptions);
    // Suppressing a repeated line is a display decision, so it hides the row
    // and never the input. Dropping the checkbox with it would leave a scope
    // the device asked for unsubmittable, which reads to the person as
    // approved and reaches the grant as absent, with nothing saying so.
    const duplicateLine = seenLines.has(human);
    seenLines.add(human);
    if (hiddenLiterals.has(literal)) {
      // Submitted hidden, because no per-scope decision applies to a
      // mechanism — but still *stated*, which is where this screen differs
      // from the authorize screen and should. That one renders the request
      // beside a client name and a signed query; this one is what somebody
      // reads on a phone after typing a code, and it named these before the
      // rows became toggles. Making them invisible would be paying for the
      // consistency with disclosure, which is the wrong trade on the screen
      // that has less context to begin with.
      hidden.push(
        `<input type="checkbox" name="scopes" value="${safeLiteral}" checked hidden>`,
      );
      if (!duplicateLine) {
        visible.push(
          `<div class="subrow"><span>${escapeHtml(human)}</span></div>`,
        );
      }
      continue;
    }
    const checked =
      requiresExplicitConsent(literal) || reachesWithheld(literal)
        ? ""
        : " checked";
    // A repeated line renders its toggle with no label rather than being
    // dropped: the input has to reach the form whatever the copy does.
    const label = duplicateLine ? "" : escapeHtml(human);
    // How far the grant reaches, in the line the authorize screen sets under
    // the same row. Printed with the label so a repeated line drops both.
    const reach =
      !duplicateLine && isOpenEnded(scope)
        ? `<span class="rmeta">${escapeHtml(OPEN_ENDED_LINE)}</span>`
        : "";
    visible.push(
      `<div class="subrow"><span>${label}${reach}</span><label class="sw"><input type="checkbox" name="scopes" value="${safeLiteral}"${checked}><span class="tk" aria-hidden="true"></span></label></div>`,
    );
  }

  // The code is a display (the user confirms it matches their other device),
  // not an entry input — show it whole in a soft code tile.
  const bodyHtml = `
    <h1 class="title">Approve sign-in</h1>
    <p class="sub"><b>${safeClient}</b> is trying to sign in as you. Approve only if this code matches what's on that device.</p>
    ${params.unverified ? unverifiedAppCallout() : ""}
    <div class="codetile">${safeUserCode}</div>
    <div class="actions">
      <form method="POST" action="/auth/device/consent" novalidate>
        <input type="hidden" name="user_code" value="${safeUserCode}">
        <input type="hidden" name="decision" value="approve">
        ${hidden.join("")}
        <div class="gsub" style="margin-bottom:10px">${visible.join("")}</div>
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
