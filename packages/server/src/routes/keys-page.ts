/**
 * Console page renderer for `/auth/keys`.
 *
 * Auth-gated (Better Auth cookie session). Lets a signed-in tenant owner
 * mint, view, and revoke their own long-lived `marfa_k1_` API keys without
 * dropping to the bearer-only data plane — the self-serve credential path a
 * brand-new hosted user needs after sign-up + verification.
 *
 * The data plane (`/items`, `/keys`, …) stays strictly bearer-only by
 * design; this surface lives in the `/auth/*` zone where the session cookie
 * is the authenticator. The freshly-minted plaintext key is shown exactly
 * once, in the POST response body (never via a redirect query), since it is
 * unrecoverable afterwards.
 *
 * Uses the shared auth-page layout, wide variant.
 */

import { renderAuthLayout } from "./auth-layout.js";

export interface KeysPageKey {
  id: string;
  label: string;
  source: string;
  created_at: string;
  last_used_at: string | null;
}

export interface KeysPageNotice {
  kind: "success" | "error";
  text: string;
}

export interface KeysPageParams {
  email: string;
  keys: KeysPageKey[];
  /** Plaintext of a key minted on this request — shown once, never stored. */
  newKey?: string;
  notice?: KeysPageNotice;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Short ISO date (YYYY-MM-DD HH:MM UTC) — human-scannable, not precise. */
function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

export function renderKeysPage(params: KeysPageParams): string {
  const safeEmail = escapeHtml(params.email);

  const noticeHtml = params.notice
    ? `<div class="banner banner--${params.notice.kind === "success" ? "success" : "error"}" role="${
        params.notice.kind === "success" ? "status" : "alert"
      }">${escapeHtml(params.notice.text)}</div>`
    : "";

  // The one-time plaintext reveal. Rendered into the POST response body
  // directly so it never lands in URL history or server access logs.
  const newKeyHtml = params.newKey
    ? `<div class="banner banner--success" role="status">
        <p>Your new API key — copy it now, it won't be shown again:</p>
        <code class="scope-literal">${escapeHtml(params.newKey)}</code>
      </div>`
    : "";

  const createForm = `<div class="section">
    <h2>Create a key</h2>
    <form method="POST" action="/auth/keys">
      <label class="field">
        <span class="field__label">Label</span>
        <input type="text" name="label" required maxlength="200"
          placeholder="e.g. laptop CLI" autocomplete="off">
      </label>
      <button type="submit" class="btn btn--primary">Create key</button>
    </form>
  </div>`;

  const keysSection =
    params.keys.length === 0
      ? `<div class="section">
          <h2>Your keys</h2>
          <p class="field__hint">You have no API keys yet.</p>
        </div>`
      : `<div class="section">
          <h2>Your keys</h2>
          ${params.keys
            .map((k) => {
              const safeId = escapeHtml(k.id);
              const safeLabel = escapeHtml(k.label);
              const lastUsed = k.last_used_at
                ? `Last used ${escapeHtml(formatDate(k.last_used_at))}`
                : "Never used";
              return `<div class="row">
                <div class="row__main">
                  <div class="row__title">${safeLabel}</div>
                  <div class="row__meta">Created ${escapeHtml(formatDate(k.created_at))} · ${lastUsed}</div>
                </div>
                <form method="POST" action="/auth/keys/${safeId}/revoke" class="row__action">
                  <button type="submit" class="btn btn--danger">Revoke</button>
                </form>
              </div>`;
            })
            .join("\n")}
        </div>`;

  const bodyHtml = `
    <h1>API keys</h1>
    <p class="lede">Create a long-lived key to use the Marfa API and CLI.</p>
    <p class="lede">Signed in as <strong>${safeEmail}</strong>.</p>

    ${noticeHtml}
    ${newKeyHtml}
    ${createForm}
    ${keysSection}
  `;

  return renderAuthLayout({
    title: "API keys",
    bodyHtml,
    wide: true,
  });
}
