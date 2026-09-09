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
import { spacePermissionShort } from "./space-permission-labels.js";
import { scopeOperation } from "./scope-operation.js";
import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

export interface SecurityPageGrant {
  id: string;
  client_name: string;
  client_id: string;
  scopes: string[];
  granted_at: string;
  last_used_at: string | null;
  /**
   * How many live API keys this app minted in the space. Zero for an app that
   * was never granted the permission to make one, which is most of them.
   *
   * Drives the offer on the revoke form. A count rather than a boolean because
   * the person is being asked to destroy credentials and deserves to know how
   * many, and because "1 key" and "9 keys" are different decisions.
   */
  key_count: number;
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
  /**
   * Whether this instance can delete an account, which is whether it has an
   * account-lifecycle store wired.
   *
   * Rendered as a flag rather than assumed, because without that store the
   * routes are a no-op router and every path under `/auth/account/delete` is a
   * 404 — a button leading to one is worse than no button. Defaults to false,
   * so a caller that has not thought about it gets the page without the
   * section rather than a broken one.
   */
  accountDeletable?: boolean;
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

/**
 * Plain-English summary of what a grant lets an app do, so the person
 * deciding whether to revoke it never has to read a permission literal.
 *
 * Asked of the parser, not of the characters. A substring test reads
 * `metadata.types:write` and `edge.parent-of:write` as the same permission
 * while they say different things, sees nothing at all in a literal it does
 * not recognize, and this one line is most of what a person acts on.
 *
 * **Every scope is counted before anything is said.** Two earlier versions
 * returned on first sight — one arm for a write, one for a space
 * permission — and neither implied the other, so the sentence depended on
 * the order the scopes happened to arrive in. `["space.app_grants", "core.note:write"]` and
 * the same pair reversed produced different lines, each omitting what the
 * other named, and the page renders exactly one line, so the loser was not
 * merely unnamed but unmentioned. The default flow landed on the worse of the
 * two: the consent screen renders administrative access last and a form
 * submits in document order, so an app holding both read as content access
 * with its administrative reach invisible.
 *
 * **Space permissions are named, not summarized.** No single sentence covers
 * this set honestly. `upstream_access` reaches outside the space entirely, to
 * the person's account at the third-party service. `item_purge` is the
 * contents rather than anything around them. `app_grants` revokes other apps,
 * which is this page's own subject. And `audit_read` and `usage` are reads
 * that any collective phrasing overstates. So the line lists what was
 * granted, from the same labels the consent screen used, and a person meets
 * the same words in both places.
 *
 * A literal the parser refuses contributes nothing, because it grants
 * nothing: every projection onto the permission maps drops it. A family this
 * build has never heard of may authorize a great deal and there is nothing
 * to base a narrow claim on, so it reads as the widest. Overstating an app's
 * reach costs a revoke nobody needed; understating it loses the decision
 * this page exists for.
 *
 * **What a scope permits is asked of `scope-operation.ts`, the same module
 * the consent screens ask.** This page is where somebody comes to review a
 * grant a consent screen took, so the two describing one grant in two
 * vocabularies would be a defect visible only to the person who saw both.
 * The switch stays, because it answers a different question — which clause
 * of this sentence a scope feeds — and only the read/write derivation folds.
 */
function scopeSummary(scopes: readonly string[]): string {
  let writesData = false;
  let readsData = false;
  let identifiesYou = false;
  let unknownFamily = false;
  const spacePermissions: string[] = [];

  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (!parsed) continue;
    switch (parsed.kind) {
      // Every family that carries a verb, the content category included. It
      // gets no clause of its own: this line is a glance, and "read and write
      // your data" is already the widest honest phrasing of a category grant.
      // Saying how large it is needs a sentence, which is the consent
      // screen's job rather than this row's.
      case "type":
      case "edge":
      case "metadata":
      case "content": {
        // Asked of `scopeOperation` rather than read off `parsed.operation`,
        // so the one derivation the consent screens use is the one this page
        // uses. Two copies of a rule are two rules eventually, and this arm
        // already answered differently from that module at one input: it
        // read a verb-bearing scope carrying no verb as a read, where that
        // module refuses to answer for it. Nothing produces that input today
        // — `parseScope` gives "none" only to the two verb-less families,
        // which never reach this arm — so folding changes no rendered line.
        // It removes the second derivation, which is the argument
        // `scope-operation.ts` makes for existing.
        const operation = scopeOperation(parsed);
        if (operation === "write") writesData = true;
        else if (operation === "read") readsData = true;
        // A verb-bearing scope with no verb grants nothing, but nothing here
        // can tell that from a grammar this build predates, so it lands with
        // the other family this page cannot characterize. Overstating costs
        // a revoke nobody needed, which is the direction this whole function
        // already leans.
        else unknownFamily = true;
        break;
      }
      case "profile": {
        // Category 2 is about the person rather than their content, so a read
        // lands with the OIDC family below: what it buys is knowing who you
        // are. A write is not the same fact and must not collapse into it —
        // it changes your name, your handle or your avatar — so it also sets
        // the data-writing flag.
        //
        // That overstates by a shade, since your profile is not your content.
        // It is the direction this function already leans, and the honest
        // alternative is a fourth clause on a line that exists to be glanced
        // at. Naming the category precisely is the consent screen's job.
        identifiesYou = true;
        if (scopeOperation(parsed) === "write") writesData = true;
        break;
      }
      case "oidc":
        identifiesYou = true;
        break;
      case "space": {
        const named = spacePermissionShort(parsed.typePattern);
        // An unnamed space permission cannot be listed, but it must not vanish
        // either. The exhaustive label map makes this unreachable in a
        // build that compiles; it is here for one that did not.
        if (named === undefined) unknownFamily = true;
        else if (!spacePermissions.includes(named))
          spacePermissions.push(named);
        break;
      }
      default: {
        // Compile-time exhaustiveness check. A family added to the grammar
        // decides here what it lets an app do, and reads as the widest until
        // somebody does. Unlike the unparseable literal above, this one may
        // carry real authority.
        const _exhaustive: never = parsed.kind;
        void _exhaustive;
        unknownFamily = true;
        break;
      }
    }
  }

  const clauses: string[] = [];
  if (unknownFamily) clauses.push("manage your space");
  if (writesData) clauses.push("read and write your data");
  else if (readsData) clauses.push("read your data");
  // Two named, then a count. Four space permissions spelled out in full is a
  // paragraph in a table row, and the row is a glance rather than a reading.
  if (spacePermissions.length > 0) {
    const listed = spacePermissions.slice(0, 2);
    const remainder = spacePermissions.length - listed.length;
    clauses.push(...listed);
    if (remainder > 0) {
      clauses.push(
        `${String(remainder)} more thing${remainder > 1 ? "s" : ""}`,
      );
    }
  }

  if (clauses.length === 0) {
    if (identifiesYou) return "Can see who you are, nothing else";
    return "No access to your data";
  }
  if (clauses.length === 1) return `Can ${clauses[0] ?? ""}`;
  const last = clauses[clauses.length - 1] ?? "";
  return `Can ${clauses.slice(0, -1).join(", ")}, and ${last}`;
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
            // The offer to take the app's keys with it, shown only when
            // there are any. Ticked by default, because disconnecting an app
            // and leaving a credential it made behind is the surprising half;
            // untickable, because the key is the person's and something of
            // theirs may be holding it.
            const keyOffer =
              g.key_count === 0
                ? ""
                : `<label class="row__meta"><input type="checkbox" name="revoke_keys" value="1" checked> Also revoke the ${String(g.key_count)} API ${g.key_count === 1 ? "key" : "keys"} this app made</label>`;
            return `<div class="row">
              <div class="row__main">
                <div class="row__title">${safeName}</div>
                <div class="row__meta">${escapeHtml(scopeSummary(g.scopes))}</div>
                <div class="row__meta row__meta--faint">${activity}</div>
              </div>
              <form method="POST" action="/auth/grants/${safeId}/revoke" class="row__action">
                ${keyOffer}
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

  // The only way a person can start deleting their own account. It used to be
  // reachable from a bearer credential and from the command line and from no
  // screen at all, which is backwards: it is a person's act, so it belongs on
  // the page where a person manages their account, and nowhere a credential
  // can reach. Nothing happens on the press but an email — the confirm link
  // is the destructive step, and it goes to the mailbox rather than to
  // whoever pressed the button.
  const deleteSection = !params.accountDeletable
    ? ""
    : `<p class="lsec">Delete account</p>
        <div class="row">
          <div class="row__main">
            <div class="row__title">Delete this account</div>
            <div class="row__meta">This removes the account, its space, and everything in it.</div>
            <div class="row__meta row__meta--faint">We email you a link to confirm. Nothing is deleted until you open it.</div>
          </div>
          <form method="POST" action="/auth/account/delete" class="row__action">
            <button type="submit" class="btn btn--outline btn--sm">Delete account</button>
          </form>
        </div>`;

  const bodyHtml = `
    <h1 class="title">Security</h1>
    <p class="sub">Manage what has access to your account.</p>
    <p class="sub">Signed in as <strong>${safeEmail}</strong>.</p>

    ${noticeHtml}
    ${grantsSection}
    ${sessionsSection}
    ${deleteSection}
  `;

  return renderAuthLayout({
    title: "Security",
    bodyHtml,
    wide: true,
  });
}
