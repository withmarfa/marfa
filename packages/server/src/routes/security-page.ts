/**
 * Security page renderer for `/auth/security`.
 *
 * Wave C PR7 / T-031. Auth-gated. Shows two surfaces:
 *
 *   1. Connected apps — `system.connection user-app-grant` items
 *      with name (resolved from oauth_clients), scope summary,
 *      granted date, last-used date (if any), and a Revoke button
 *      that POSTs to `/auth/grants/:id/revoke` (form-friendly
 *      counterpart to the existing API DELETE).
 *
 *   2. Active sessions — better-auth's list-sessions output, with
 *      created-at, last-active, IP + user-agent hints, and a Revoke
 *      button per row plus a "Sign out everywhere" button at the
 *      bottom (revokes every session for this user, including
 *      current — current redirects to /auth/sign-in on the next
 *      request).
 *
 * Uses the shared auth-page layout, wide variant.
 */

import { renderAuthLayout } from "./auth-layout.js";

export interface SecurityPageGrant {
  id: string;
  client_name: string;
  client_id: string;
  scopes: string[];
  granted_at: string;
  last_used_at: string | null;
}

export interface SecurityPageSession {
  /** Better-auth session id (`auth_session.id`). Hidden form field
   *  on the per-session revoke button. */
  id: string;
  created_at: string;
  /** Better-auth uses `updatedAt` as the "last active" signal —
   *  refreshed on every authenticated request. */
  last_active_at: string;
  /** True for the session whose cookie this request was made under.
   *  Render the per-session row with a "(current device)" tag and
   *  disable its Revoke button (use Sign out everywhere instead). */
  is_current: boolean;
  ip_address: string | null;
  user_agent: string | null;
}

interface SecurityPageParams {
  email: string;
  grants: readonly SecurityPageGrant[];
  sessions: readonly SecurityPageSession[];
  /** Optional flash banner — set by the route handlers to confirm a
   *  revoke / sign-out-all action. */
  notice?: { kind: "success" | "error"; text: string };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pretty short ISO date (YYYY-MM-DD HH:MM UTC). Trades absolute
 *  precision for human-scannability. */
function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${String(yyyy)}-${mm}-${dd} ${hh}:${min} UTC`;
}

/** Trim a UA string to a hint. Real device parsing is a yak-shave;
 *  the user only needs enough to recognise their devices. */
function uaHint(ua: string | null): string {
  if (!ua) return "Unknown device";
  // Pull a friendly shape: prefer the OS / device hint over the
  // browser engine for recognition.
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iPhone / iPad";
  if (ua.includes("Macintosh")) return "Mac";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Linux")) return "Linux";
  return ua.length > 60 ? ua.slice(0, 60) + "…" : ua;
}

export function renderSecurityPage(params: SecurityPageParams): string {
  const safeEmail = escapeHtml(params.email);

  const noticeHtml = params.notice
    ? `<div class="banner banner--${params.notice.kind === "success" ? "success" : "error"}" role="${
        params.notice.kind === "success" ? "status" : "alert"
      }">${escapeHtml(params.notice.text)}</div>`
    : "";

  const grantsSection =
    params.grants.length === 0
      ? `<div class="section">
          <h2>Connected apps</h2>
          <p class="field__hint">No third-party apps are connected to your account.</p>
        </div>`
      : `<div class="section">
          <h2>Connected apps</h2>
          ${params.grants
            .map((g) => {
              const safeName = escapeHtml(g.client_name);
              const safeId = escapeHtml(g.id);
              const safeScopes = g.scopes
                .map(
                  (s) => `<code class="scope-literal">${escapeHtml(s)}</code>`,
                )
                .join(" ");
              const lastUsed = g.last_used_at
                ? `Last used ${escapeHtml(formatDate(g.last_used_at))}`
                : `Never used`;
              return `<div class="row">
                <div class="row__main">
                  <div class="row__title">${safeName}</div>
                  <div class="row__meta">${safeScopes}</div>
                  <div class="row__meta">Granted ${escapeHtml(formatDate(g.granted_at))} · ${lastUsed}</div>
                </div>
                <form method="POST" action="/auth/grants/${safeId}/revoke" class="row__action">
                  <button type="submit" class="btn btn--danger">Revoke</button>
                </form>
              </div>`;
            })
            .join("\n")}
        </div>`;

  const sessionsSection = `<div class="section">
    <h2>Active sessions</h2>
    ${params.sessions
      .map((s) => {
        const safeId = escapeHtml(s.id);
        const safeIp = s.ip_address ? escapeHtml(s.ip_address) : "Unknown IP";
        const safeUa = escapeHtml(uaHint(s.user_agent));
        const currentTag = s.is_current
          ? ` <span class="tag tag--current">current device</span>`
          : "";
        const revokeButton = s.is_current
          ? `<button type="button" class="btn btn--danger" disabled title="Use Sign out everywhere to revoke the current session">Revoke</button>`
          : `<form method="POST" action="/auth/sessions/${safeId}/revoke" class="row__action">
              <button type="submit" class="btn btn--danger">Revoke</button>
            </form>`;
        return `<div class="row">
          <div class="row__main">
            <div class="row__title">${safeUa}${currentTag}</div>
            <div class="row__meta">${safeIp}</div>
            <div class="row__meta">Signed in ${escapeHtml(formatDate(s.created_at))} · Last active ${escapeHtml(formatDate(s.last_active_at))}</div>
          </div>
          ${revokeButton}
        </div>`;
      })
      .join("\n")}
  </div>
  <form method="POST" action="/auth/sessions/sign-out-all" class="actions">
    <button type="submit" class="btn btn--danger">Sign out everywhere</button>
  </form>`;

  const bodyHtml = `
    <h1>Security</h1>
    <p class="lede">Manage who has access to your Myme account.</p>
    <p class="lede">Signed in as <strong>${safeEmail}</strong>.</p>

    ${noticeHtml}
    ${grantsSection}
    ${sessionsSection}
  `;

  return renderAuthLayout({
    title: "Security",
    bodyHtml,
    wide: true,
  });
}
