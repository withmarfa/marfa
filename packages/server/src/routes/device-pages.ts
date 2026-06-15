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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

/** A trailing, checked + disabled squared check: an informational
 *  "will be granted" affirmation, not a toggle. */
const GRANTED_CHECK = `<input type="checkbox" class="chk" checked disabled aria-hidden="true" tabindex="-1">`;

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

/**
 * Split a user_code display into two halves around a dash for the
 * `.codebox` (e.g. `WDJB-MJHT` → `["WDJB", "MJHT"]`). Codes already
 * carrying a separator split on it; an even-length unseparated code splits
 * down the middle; anything else renders as a single segment.
 */
function splitUserCode(code: string): string[] {
  if (code.includes("-")) {
    return code.split("-").filter((seg) => seg.length > 0);
  }
  if (code.length >= 2 && code.length % 2 === 0) {
    return [code.slice(0, code.length / 2), code.slice(code.length / 2)];
  }
  return [code];
}

/** Renders the verification form where the user types the user_code. */
export function renderDevicePage(params: DevicePageParams): string {
  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
    : null;
  const errorBanner = errorMessage
    ? `<div class="banner banner--error" role="alert">${escapeHtml(errorMessage)}</div>`
    : "";
  const safePrefilled = escapeHtml(params.prefilled);

  const bodyHtml = `
    <h1>Device sign-in</h1>
    <p class="lede">Enter the code shown on your other device to authorize it.</p>
    ${errorBanner}
    <form method="POST" action="/auth/device" class="form" novalidate>
      <label class="field">
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
      </label>
      <button type="submit" class="btn btn--primary">Continue</button>
    </form>
  `;

  return renderAuthLayout({ title: "Device sign-in", bodyHtml });
}

/** Renders the consent screen for an approved device-code journey. */
export function renderDeviceConsentScreen(params: DeviceConsentParams): string {
  const safeClient = escapeHtml(params.clientName);
  const safeUserCode = escapeHtml(params.userCode);

  // Friendly, deduped capability labels rendered as static "will be
  // granted" rows — each carries a trailing checked + disabled check.
  const capRows = describeCapabilities(params.scopes, params.descriptions)
    .map(
      (human) =>
        `<div class="cap"><span class="cap__text"><span class="cap__title">${escapeHtml(human)}</span></span>${GRANTED_CHECK}</div>`,
    )
    .join("");

  // The code is a *display* (the user confirms it matches their other
  // device), not an entry input — render it in the box that hugs the code,
  // split into two halves around a dash.
  const codeSegments = splitUserCode(params.userCode)
    .map((seg) => `<span class="codebox__seg">${escapeHtml(seg)}</span>`)
    .join(`<span class="codebox__dash">–</span>`);

  const bodyHtml = `
    <header style="text-align:center">
      <h1>Approve sign-in</h1>
      <p class="lede"><span class="client-name">${safeClient}</span> on another device is trying to sign in as you. Approve only if this code matches what you see there.</p>
    </header>
    <div class="codebox-wrap"><div class="codebox">${codeSegments}</div></div>
    <h2>What it can do</h2>
    <div class="caps">
      ${capRows}
    </div>
    <div class="actions">
      <form method="POST" action="/auth/device/consent" novalidate>
        <input type="hidden" name="user_code" value="${safeUserCode}">
        <input type="hidden" name="decision" value="approve">
        <button type="submit" class="btn btn--primary">Approve sign-in</button>
      </form>
      <form method="POST" action="/auth/device/consent" novalidate>
        <input type="hidden" name="user_code" value="${safeUserCode}">
        <input type="hidden" name="decision" value="deny">
        <button type="submit" class="btn btn--outline">Deny</button>
      </form>
    </div>
    <p class="consent-footnote">If you didn't start this, deny and change your password.</p>
  `;

  return renderAuthLayout({
    title: "Approve device sign-in",
    bodyHtml,
    wide: true,
  });
}

/** Renders the result page after the user approves or denies. */
export function renderDeviceDecisionPage(params: DeviceDecisionParams): string {
  const heading = params.approved
    ? "You're signed in"
    : "You denied the request";
  const lede = params.approved
    ? "You can return to your other device — it will pick up the sign-in shortly."
    : "Your other device will not be granted access. You can close this window.";
  const banner = params.approved
    ? `<div class="banner banner--success" role="status">${escapeHtml(lede)}</div>`
    : `<div class="banner banner--error" role="status">${escapeHtml(lede)}</div>`;

  const bodyHtml = `
    <h1>${escapeHtml(heading)}</h1>
    ${banner}
  `;

  return renderAuthLayout({ title: heading, bodyHtml });
}
