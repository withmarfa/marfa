/**
 * Security page renderer for `/auth/security`.
 *
 * Auth-gated. Shows two surfaces:
 *
 *   1. Connected apps — `system.connection` items of kind `app`
 *      with name (resolved from oauth_clients), scope summary,
 *      granted date, last-used date (if any), and a Revoke button
 *      that POSTs to `/auth/grants/:id/revoke` (form-friendly
 *      counterpart to the existing API DELETE).
 *
 *   2. Active sessions — better-auth's list-sessions output, with
 *      created-at, last-active, IP + user-agent hints, and a "Sign
 *      out" button on every session except the current one (which
 *      carries a "(This device)" marker and no button). A "Sign out
 *      everywhere" danger-zone button at the bottom revokes every
 *      session for this user, including current — current redirects
 *      to /auth/sign-in on the next request.
 *
 * Uses the shared auth-page layout, wide variant.
 */

import { parseScope } from "@withmarfa/shared";
import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

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
   *  Render the per-session row with a muted "(This device)" marker on
   *  the title and no action button — "Sign out everywhere" ends it. */
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

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Friendly calendar date, e.g. "11 May 2026" — human-scannable, no
 *  clock time or timezone noise. */
function formatDate(iso: string): string {
  if (!iso) return "Unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = MONTHS[d.getUTCMonth()] ?? "";
  return `${String(d.getUTCDate())} ${month} ${String(d.getUTCFullYear())}`;
}

/** The widest thing this page says about an app, and what a permission family
 *  this build cannot classify falls back to. */
const READ_AND_WRITE_SUMMARY = "Can read and write your data";

/**
 * Plain-English summary of what a grant lets an app do, so the person
 * deciding whether to revoke it never has to read a permission literal.
 *
 * Asked of the parser, not of the characters. A substring test reads
 * `metadata.types:write` and `edge.parent-of:write` as the same permission
 * while they say different things, sees nothing at all in a literal it does
 * not recognize, and this one line is most of what a person acts on.
 *
 * Two things resist classification, and they are answered in opposite
 * directions because they are opposite situations. A literal the parser
 * refuses is enforced as nothing, since every projection onto the permission
 * maps drops it, so the narrow reading is not a guess but the fact. A family
 * this build has never heard of may authorize a great deal, and there is
 * nothing to base a narrow claim on, so it reads as the widest. Overstating
 * an app's reach costs a revoke nobody needed; understating it loses the
 * decision this page exists for.
 */
function scopeSummary(scopes: readonly string[]): string {
  let readsSomething = false;
  let identifiesYou = false;

  for (const scope of scopes) {
    const parsed = parseScope(scope);
    // Contributes nothing, because it grants nothing: the auth middleware
    // builds every permission map through the same parser and drops what it
    // cannot read. Reporting the widest here would flip a whole page of
    // grants to "read and write" the day the pattern grammar tightens, for
    // permissions that by then enforce as nothing.
    if (!parsed) continue;
    switch (parsed.kind) {
      case "type":
      case "edge":
      case "metadata":
        if (parsed.operation === "write") return READ_AND_WRITE_SUMMARY;
        readsSomething = true;
        break;
      case "oidc":
        identifiesYou = true;
        break;
      default: {
        // Compile-time exhaustiveness check. A family added to the grammar
        // decides here what it lets an app do, and reads as the widest until
        // somebody does. Unlike the unparseable literal above, this one may
        // carry real authority.
        const _exhaustive: never = parsed.kind;
        void _exhaustive;
        return READ_AND_WRITE_SUMMARY;
      }
    }
  }

  if (readsSomething) return "Can read your data";
  if (identifiesYou) return "Can see who you are, nothing else";
  return "No access to your data";
}

/** Trim a UA string to a hint. Real device parsing is a yak-shave;
 *  the user only needs enough to recognize their devices. */
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
      ? `<p class="lsec">Connected apps</p>
        <p class="field__hint">No third-party apps are connected to your account.</p>`
      : `<p class="lsec">Connected apps</p>
        ${params.grants
          .map((g) => {
            const safeName = escapeHtml(g.client_name);
            const safeId = escapeHtml(g.id);
            const activity = g.last_used_at
              ? `Last used ${escapeHtml(formatDate(g.last_used_at))}`
              : `Connected ${escapeHtml(formatDate(g.granted_at))}`;
            return `<div class="row">
              <div class="row__main">
                <div class="row__title">${safeName}</div>
                <div class="row__meta">${escapeHtml(scopeSummary(g.scopes))}</div>
                <div class="row__meta row__meta--faint">${activity}</div>
              </div>
              <form method="POST" action="/auth/grants/${safeId}/revoke" class="row__action">
                <button type="submit" class="btn btn--outline btn--sm">Revoke</button>
              </form>
            </div>`;
          })
          .join("\n")}`;

  const sessionsSection = `<p class="lsec">Active sessions</p>
    ${params.sessions
      .map((s) => {
        const safeId = escapeHtml(s.id);
        const safeIp = s.ip_address ? escapeHtml(s.ip_address) : "Unknown IP";
        const safeUa = escapeHtml(uaHint(s.user_agent));
        // The current session is marked by a muted "(This device)" suffix on
        // the title — no action button, since "Sign out everywhere" ends it.
        const deviceMarker = s.is_current
          ? ` <span class="this-device">(This device)</span>`
          : "";
        const action = s.is_current
          ? ""
          : `<form method="POST" action="/auth/sessions/${safeId}/revoke" class="row__action">
              <button type="submit" class="btn btn--outline btn--sm">Sign out</button>
            </form>`;
        const activity = s.is_current
          ? "Active now"
          : `Last active ${escapeHtml(formatDate(s.last_active_at))}`;
        return `<div class="row">
          <div class="row__main">
            <div class="row__title">${safeUa}${deviceMarker}</div>
            <div class="row__meta">${safeIp}</div>
            <div class="row__meta row__meta--faint">${activity}</div>
          </div>
          ${action}
        </div>`;
      })
      .join("\n")}
    <div class="actions" style="margin-top:18px">
      <form method="POST" action="/auth/sessions/sign-out-all">
        <button type="submit" class="btn btn--ghost">Sign out everywhere</button>
      </form>
    </div>`;

  const bodyHtml = `
    <h1 class="title">Security</h1>
    <p class="sub">Manage what has access to your account.</p>
    <p class="sub">Signed in as <strong>${safeEmail}</strong>.</p>

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
