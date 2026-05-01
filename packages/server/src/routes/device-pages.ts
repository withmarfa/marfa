/**
 * HTML pages for the Device Authorization Grant flow (RFC 8628):
 * verification form, consent screen, and decision-result page.
 *
 * Same minimalist scaffolding as sign-in / sign-up — server-rendered,
 * inline CSS, no client-side framework. The verification page accepts
 * an optional `user_code` query param to pre-fill the form (so the
 * `verification_uri_complete` link the CLI prints can land the user
 * directly at consent).
 */

import type { ParsedScope } from "@mymehq/shared";

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

const STYLES = `
  :root {
    color-scheme: light;
    --bg: #fafaf8;
    --card: #ffffff;
    --ink: #1a1a1a;
    --ink-soft: #555;
    --ink-faint: #999;
    --border: #e2e2dc;
    --accent: #1a1a1a;
    --accent-hover: #333;
    --error-bg: #fdecec;
    --error-border: #f5b8b8;
    --error-ink: #842424;
    --success-bg: #ecf6e9;
    --success-border: #b8d8af;
    --success-ink: #2a5a1f;
  }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--ink);
    min-height: 100vh;
    display: grid;
    place-items: center;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    width: 100%;
    max-width: 460px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.01em; }
  .lede { color: var(--ink-soft); margin: 0 0 24px; font-size: 14px; }
  .banner {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid;
    font-size: 13px;
    line-height: 1.4;
  }
  .banner--error { background: var(--error-bg); border-color: var(--error-border); color: var(--error-ink); }
  .banner--success { background: var(--success-bg); border-color: var(--success-border); color: var(--success-ink); }
  .form { display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field__label { font-size: 13px; color: var(--ink-soft); font-weight: 500; }
  input[type="text"] {
    font: 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.1em;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink);
    width: 100%;
    text-align: center;
    text-transform: uppercase;
  }
  input:focus {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
    border-color: var(--ink);
  }
  .btn {
    font: inherit;
    padding: 10px 16px;
    border-radius: 6px;
    border: 1px solid var(--ink);
    cursor: pointer;
    font-weight: 500;
    background: var(--card);
    color: var(--ink);
  }
  .btn--primary { background: var(--accent); color: var(--card); }
  .btn--primary:hover { background: var(--accent-hover); }
  .btn--danger { background: var(--card); color: var(--ink); border-color: var(--ink-soft); }
  .btn--danger:hover { background: var(--bg); }
  .btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .scopes { margin: 16px 0; padding: 0; list-style: none; }
  .scopes li {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 6px;
    font-size: 13px;
  }
  .scopes code {
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--ink-faint);
    display: block;
    margin-top: 2px;
  }
  .actions {
    display: flex;
    gap: 12px;
    margin-top: 20px;
  }
  .actions form { flex: 1; margin: 0; }
  .actions button { width: 100%; }
  .client-name {
    font-weight: 600;
    color: var(--ink);
  }
`;

/** Renders the verification form where the user types the user_code. */
export function renderDevicePage(params: DevicePageParams): string {
  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
    : null;
  const errorBanner = errorMessage
    ? `<div class="banner banner--error" role="alert">${escapeHtml(errorMessage)}</div>`
    : "";
  const safePrefilled = escapeHtml(params.prefilled);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Device sign-in</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="card" aria-labelledby="page-title">
    <h1 id="page-title">Device sign-in</h1>
    <p class="lede">Enter the code shown on your other device to authorise it.</p>
    ${errorBanner}
    <form method="POST" action="/auth/device" class="form" novalidate>
      <label class="field">
        <span class="field__label">Code</span>
        <input type="text"
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
  </main>
</body>
</html>`;
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approve device sign-in</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="card" aria-labelledby="page-title">
    <h1 id="page-title">Approve device sign-in</h1>
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
  </main>
</body>
</html>`;
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(heading)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="card" aria-labelledby="page-title">
    <h1 id="page-title">${escapeHtml(heading)}</h1>
    ${banner}
  </main>
</body>
</html>`;
}
