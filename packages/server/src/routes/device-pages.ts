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
 * Wave C PR4: layout extraction. Inline `<style>` block dropped;
 * the pages now reference the shared stylesheet at
 * `/auth/static/auth.css` via the `renderAuthLayout` helper.
 */

import type { ParsedScope } from "@mymehq/shared";
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
  invalid_code: "That code wasn't recognised. Check for typos and try again.",
  already_resolved:
    "That code has already been used. Restart the sign-in on your other device.",
  expired_code:
    "That code has expired. Restart the sign-in on your other device.",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    <p class="lede">Enter the code shown on your other device to authorise it.</p>
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
  const scopeItems = params.scopes
    .map((s) => {
      const literal = `${s.typePattern}:${s.operation}`;
      const desc = params.descriptions?.[s.typePattern];
      return `<li>
        ${desc ? `<div>${escapeHtml(desc)}</div>` : ""}
        <code>${escapeHtml(literal)}</code>
      </li>`;
    })
    .join("");

  const bodyHtml = `
    <h1>Approve device sign-in</h1>
    <p class="lede"><span class="client-name">${safeClient}</span> is requesting access. Code: <code>${safeUserCode}</code></p>
    <p>This will let the app:</p>
    <ul class="scopes">
      ${scopeItems}
    </ul>
    <div class="actions">
      <form method="POST" action="/auth/device/consent" novalidate>
        <input type="hidden" name="user_code" value="${safeUserCode}">
        <input type="hidden" name="decision" value="approve">
        <button type="submit" class="btn btn--primary">Approve</button>
      </form>
      <form method="POST" action="/auth/device/consent" novalidate>
        <input type="hidden" name="user_code" value="${safeUserCode}">
        <input type="hidden" name="decision" value="deny">
        <button type="submit" class="btn btn--danger">Deny</button>
      </form>
    </div>
  `;

  return renderAuthLayout({ title: "Approve device sign-in", bodyHtml });
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
