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
import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

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
 * Resolve the human-readable capability for a parsed scope, deduped across
 * the full set. OIDC literals map to friendly labels; everything else uses
 * the caller-supplied description, falling back to the scope literal. The
 * returned order follows first appearance in `scopes`.
 */
function describeCapabilities(
  scopes: ParsedScope[],
  descriptions?: Record<string, string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scopes) {
    const literal =
      s.kind === "oidc"
        ? (s.oidcScope ?? s.typePattern)
        : `${s.typePattern}:${s.operation}`;
    const human =
      s.kind === "oidc"
        ? (OIDC_FRIENDLY_LABELS[s.oidcScope ?? s.typePattern] ?? literal)
        : (descriptions?.[s.typePattern] ?? literal);
    if (seen.has(human)) continue;
    seen.add(human);
    out.push(human);
  }
  return out;
}

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
    <form method="POST" action="/auth/device" class="form" novalidate>
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
               aria-required="true">
        ${fieldError}
      </label>
      <div class="actions">
        <button type="submit" class="btn btn--primary" data-loading-label="Checking...">Continue</button>
      </div>
    </form>
    <script src="/auth/static/submit-state.js"></script>
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
    <h1 class="title">${escapeHtml(heading)}</h1>
    <p class="sub" role="status">${escapeHtml(sub)}</p>
  `;

  return renderAuthLayout({ title: heading, bodyHtml });
}
