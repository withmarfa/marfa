/**
 * OAuth consent screen renderer.
 *
 * The shared `/auth/static/auth.css` design tokens style the screen, unifying
 * it with sign-in / sign-up / device-flow.
 *
 * Layout: the requested scopes are grouped by capability into collapsible
 * soft-tile groups — "Read your content", "Write your content", "Your
 * profile". Every group is collapsed by default; expanding one reveals a
 * per-type toggle (Notes, Tasks, Calendar, …). Each toggle is a real
 * `name="scopes"` checkbox carrying the concrete scope literal, so the no-JS
 * path still submits the full ticked set and the issued token narrows to
 * exactly what the user keeps on. A group's master toggle drives its members
 * (JS enhancement); members reflect back onto the master (indeterminate when
 * partially ticked).
 *
 * Per-type narrowing works because the requested scopes are concrete (see
 * `DEFAULT_PERMISSION_BUNDLES`): the OAuth provider only accepts a consent
 * grant whose scopes are a subset of what was literally requested, so ticking
 * a subset of concrete scopes both passes that check and narrows the token.
 *
 * Re-consent diff: when the caller passes `priorScopes` (the scope set the
 * user previously approved on this client), the screen renders three labelled
 * sections — "New", "Already allowed", and "No longer needed" — instead of the
 * first-time grouping. First-time consent (no prior grant) renders the plain
 * three-group shape.
 *
 * Authorization flow: the @better-auth/oauth-provider plugin signs the full
 * authorize-request query string and redirects here carrying that signed blob.
 * The form POSTs back to `/auth/authorize/decision` with `{ accept, scopes[],
 * oauth_query }` — the decision route validates the ticked scopes are a subset
 * of the signed set, projects the grant, then proxies to the plugin's
 * `/oauth2/consent`.
 */

import type { ParsedScope } from "@withmarfa/shared";
import { renderAuthLayout } from "./auth-layout.js";
import { computeConsentDiff } from "./consent-diff.js";

interface ConsentParams {
  clientName: string;
  /**
   * When `true`, the client has no verified identity — a public / DCR client
   * (PKCE, `token_endpoint_auth_method: none`). The screen shows a single
   * boxed caution next to the self-asserted name; a scammer can register a
   * client named "Google Drive", so the name alone is not trustworthy.
   */
  unverified?: boolean;
  scopes: ParsedScope[];
  clientId: string;
  /**
   * The full signed query string the plugin's authorize endpoint forwarded.
   * Threaded into a hidden field and POSTed back to the decision route so the
   * plugin can verify the signature and re-hydrate the request parameters.
   */
  oauthQuery: string;
  /**
   * Plain-English description per scope, keyed by `typePattern`. Used as a
   * label fallback for scopes outside the curated label map.
   */
  descriptions?: Record<string, string>;
  /**
   * The literal scope set the user previously approved on this client. When
   * present the screen renders the re-consent diff; when absent it renders the
   * first-time three-group shape.
   */
  priorScopes?: readonly string[];
  /**
   * When set, renders an inline error banner above the form (e.g. a
   * zero-scopes accept bounced back as "tick at least one permission").
   */
  errorMessage?: string;
}

type GroupId = "read" | "write" | "profile";

const GROUP_META: Record<GroupId, { label: string; desc: string }> = {
  read: {
    label: "Read your content",
    desc: "Your notes, tasks, bookmarks, and more.",
  },
  write: {
    label: "Write your content",
    desc: "Add, edit, and organize what's in your space.",
  },
  profile: {
    label: "Your profile",
    desc: "Your name and email.",
  },
};

const GROUP_ORDER: GroupId[] = ["read", "write", "profile"];

/**
 * Short, human toggle labels keyed by type pattern. Curated for the types the
 * default grant requests; anything outside this map falls back to the scope's
 * registry description, then a humanized type name.
 */
const SCOPE_LABELS: Record<string, string> = {
  "core.note": "Notes",
  "core.task": "Tasks",
  "core.bookmark": "Bookmarks",
  "core.highlight": "Highlights",
  "core.event": "Calendar",
  "core.message": "Messages",
  "core.entity": "People and places",
  "core.entity.person": "Contacts",
  "core.entity.place": "Places",
  "core.file": "Files",
  "core.media": "Media",
  "system.connection": "Connected accounts",
  "system.integration": "Available integrations",
  "system.device": "Devices",
  "system.webhook": "Webhooks",
  "system.activity": "Activity",
  metadata: "Type definitions",
};

const OIDC_LABELS: Record<string, string> = {
  profile: "Your name",
  email: "Your email address",
  openid: "Confirm your identity",
};

const CHEVRON = `<svg class="gchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scopeLiteralFor(scope: ParsedScope): string {
  return scope.kind === "oidc"
    ? (scope.oidcScope ?? scope.typePattern)
    : `${scope.typePattern}:${scope.operation}`;
}

/** Title-case the most specific segment of a dotted type pattern, for scopes
 *  outside the curated label map (e.g. a third-party app's custom request). */
function humanizeType(typePattern: string): string {
  if (typePattern === "*") return "Everything";
  const base = typePattern.replace(/\.\*$/, "");
  const seg = base.split(".").filter(Boolean).pop() ?? base;
  const words = seg.replace(/_/g, " ").trim();
  if (!words) return typePattern;
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return typePattern.endsWith(".*") ? `${titled} (all)` : titled;
}

/** The capability group a scope belongs to. */
function groupFor(scope: ParsedScope): GroupId {
  if (scope.kind === "oidc") return "profile";
  return scope.operation === "write" ? "write" : "read";
}

/** Human toggle label for a scope. */
function labelFor(
  scope: ParsedScope,
  descriptions: Record<string, string> | undefined,
): string {
  if (scope.kind === "oidc") {
    const lit = scope.oidcScope ?? scope.typePattern;
    return OIDC_LABELS[lit] ?? humanizeType(lit);
  }
  return (
    SCOPE_LABELS[scope.typePattern] ??
    descriptions?.[scope.typePattern] ??
    humanizeType(scope.typePattern)
  );
}

/** Renders the OAuth consent screen as an HTML string. */
export function renderConsentScreen(params: ConsentParams): string {
  const safeClient = escapeHtml(params.clientName);
  const safeClientId = escapeHtml(params.clientId);
  const safeOauthQuery = escapeHtml(params.oauthQuery);
  const showDiff = params.priorScopes !== undefined;

  const parsedByLiteral = new Map<string, ParsedScope>();
  for (const s of params.scopes) parsedByLiteral.set(scopeLiteralFor(s), s);

  // `openid` and `offline_access` are OAuth mechanisms (identity base +
  // refresh token), not data permissions — they ride along as always-on
  // hidden fields rather than per-type toggles.
  const isHidden = (s: ParsedScope): boolean =>
    s.kind === "oidc" &&
    (s.oidcScope === "openid" || s.oidcScope === "offline_access");

  const hiddenFields = (scopes: ParsedScope[]): string =>
    scopes
      .filter(isHidden)
      .map(
        (s) =>
          `<input type="checkbox" name="scopes" value="${escapeHtml(scopeLiteralFor(s))}" checked hidden>`,
      )
      .join("");

  /** A single per-type toggle row. */
  const subRow = (scope: ParsedScope): string => {
    const literal = escapeHtml(scopeLiteralFor(scope));
    const label = escapeHtml(labelFor(scope, params.descriptions));
    return `<div class="subrow"><span>${label}</span><label class="sw"><input type="checkbox" name="scopes" value="${literal}" checked><span class="tk" aria-hidden="true"></span></label></div>`;
  };

  /** One collapsed soft-tile group: a master toggle in the summary, per-type
   *  toggles in the body. */
  const group = (groupId: GroupId, scopes: ParsedScope[]): string => {
    if (scopes.length === 0) return "";
    const meta = GROUP_META[groupId];
    const rows = scopes.map(subRow).join("");
    return `<details class="grp">
      <summary>
        <span class="gmain">
          <span class="gtop"><span class="glabel">${escapeHtml(meta.label)}</span>${CHEVRON}</span>
          <span class="gdesc">${escapeHtml(meta.desc)}</span>
        </span>
        <label class="sw" onclick="event.stopPropagation()"><input type="checkbox" checked aria-label="${escapeHtml(meta.label)}"><span class="tk" aria-hidden="true"></span></label>
      </summary>
      <div class="gsub">${rows}</div>
    </details>`;
  };

  /** Partition a scope set into the three groups and render the non-empty
   *  ones, in order, inside a soft-tile stack. */
  const groupedTiles = (scopes: ParsedScope[]): string => {
    const tiles = GROUP_ORDER.map((g) =>
      group(
        g,
        scopes.filter((s) => groupFor(s) === g),
      ),
    ).join("");
    return `<div class="t-soft">${tiles}</div>`;
  };

  let contentHtml: string;
  if (showDiff) {
    const nextLiterals = params.scopes.map(scopeLiteralFor);
    const diff = computeConsentDiff(params.priorScopes ?? [], nextLiterals);
    const lookup = (lits: readonly string[]): ParsedScope[] =>
      lits
        .map((lit) => parsedByLiteral.get(lit))
        .filter((s): s is ParsedScope => s !== undefined);

    const added = lookup(diff.added);
    const kept = lookup(diff.kept);
    const addedVisible = added.filter((s) => !isHidden(s));
    const keptVisible = kept.filter((s) => !isHidden(s));

    const newSection =
      addedVisible.length > 0
        ? `<p class="lsec" style="margin-top:8px">New</p>${groupedTiles(addedVisible)}`
        : "";
    const keptSection =
      keptVisible.length > 0
        ? `<p class="lsec" style="margin-top:24px">Already allowed</p>${groupedTiles(keptVisible)}`
        : "";
    // Removed scopes are being dropped, not re-granted — show their group
    // names as a quiet line, no toggles.
    const removedLabels = Array.from(
      new Set(
        diff.removed.map((lit) => {
          const lastColon = lit.lastIndexOf(":");
          const typePattern = lastColon > 0 ? lit.slice(0, lastColon) : lit;
          return SCOPE_LABELS[typePattern] ?? humanizeType(typePattern);
        }),
      ),
    );
    const removedSection =
      removedLabels.length > 0
        ? `<p class="lsec" style="margin-top:24px">No longer needed</p><p class="rmeta" style="padding-top:2px">${escapeHtml(removedLabels.join(", "))}</p>`
        : "";

    // Hidden mechanisms (openid / offline_access) that survive the diff
    // still need to submit.
    contentHtml = `${newSection}${keptSection}${removedSection}${hiddenFields([...added, ...kept])}`;
  } else {
    const visible = params.scopes.filter((s) => !isHidden(s));
    contentHtml = `${groupedTiles(visible)}${hiddenFields(params.scopes)}`;
  }

  // One boxed caution for an unverified (public / DCR) client — no inline
  // badge, no second warning.
  const callout = params.unverified
    ? `<div class="callout"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Marfa hasn't verified this app. Anyone can use this name, so only allow access if you trust it.</span></div>`
    : "";

  const errorBanner = params.errorMessage
    ? `<div class="banner banner--error" role="alert">${escapeHtml(params.errorMessage)}</div>`
    : "";

  const title = showDiff ? "Update access" : "Allow access";
  const sub = showDiff
    ? `<b>${safeClient}</b> wants to change what it can access.`
    : `<b>${safeClient}</b> wants to access your space. You can change this anytime in settings.`;
  const primaryLabel = showDiff ? "Update access" : "Allow access";

  // Each group's master toggle drives its members; members reflect back as an
  // indeterminate master when partially ticked. Scoped per `.grp` so the
  // duplicate groups in a re-consent diff don't cross-wire. The master toggle
  // carries no `name`, so only the per-type members submit. Minified with
  // `replace(/\s+/g, " ")` — no `//` line comments.
  const enhancementScript = `
    (function () {
      document.querySelectorAll('.grp').forEach(function (grp) {
        var master = grp.querySelector(':scope > summary input[type="checkbox"]');
        var members = grp.querySelectorAll('.gsub input[type="checkbox"]');
        if (!master || !members.length) return;
        master.addEventListener('change', function () {
          members.forEach(function (m) { m.checked = master.checked; });
        });
        function sync() {
          var any = false, all = true;
          members.forEach(function (m) { if (m.checked) any = true; else all = false; });
          master.checked = any;
          master.indeterminate = any && !all;
        }
        members.forEach(function (m) { m.addEventListener('change', sync); });
        sync();
      });
    })();
  `
    .trim()
    .replace(/\s+/g, " ");

  const bodyHtml = `
    <h1 class="title">${escapeHtml(title)}</h1>
    <p class="sub">${sub}</p>
    ${callout}
    ${errorBanner}
    <form method="POST" action="/auth/authorize/decision" class="consent-form" novalidate>
      <input type="hidden" name="client_id" value="${safeClientId}">
      <input type="hidden" name="oauth_query" value="${safeOauthQuery}">
      ${contentHtml}
      <div class="actions">
        <button type="submit" name="accept" value="true" class="btn btn--primary">${escapeHtml(primaryLabel)}</button>
        <button type="submit" name="accept" value="false" class="btn btn--ghost">Deny</button>
      </div>
    </form>
    <script>${enhancementScript}</script>
  `;

  return renderAuthLayout({
    title: showDiff
      ? `Update access — ${params.clientName}`
      : `Authorize ${params.clientName}`,
    bodyHtml,
  });
}
