/**
 * HTML consent screen for the integration install flow.
 *
 * Renders through the shared auth layout (`renderAuthLayout` +
 * `/auth/static/auth.css`) so it tracks the same locked language as every
 * other auth surface — no duplicated inline stylesheet. The capability the
 * connector adds sits in a soft tile; the raw type identifiers and scope
 * strings live behind a collapsed "Technical details" disclosure (hidden by
 * default); the actions are stacked pill buttons.
 *
 * Distinct from OAuth consent because the granted scopes come from the
 * manifest, not OAuth client registration, and there's no PKCE round-trip —
 * the install posts straight back to the same path with a `decision` field
 * (approve | deny) plus an optional connection-label override.
 *
 * The app tile is deliberately neutral: the manifest carries no icon or
 * brand-color field, so a soft tile with a dark glyph is the honest
 * representation.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

interface ConsentParams {
  integrationId: string;
  manifestName: string;
  manifestVersion: string;
  publisher: string;
  summary: string;
  direction: "read" | "write" | "both";
  manifest: Record<string, unknown>;
  /**
   * Optional pre-arm: id of a same-tenant `system.credential` of
   * `kind: oauth_token` the caller wants the install to reuse. When
   * set the form renders a hidden `credential_ref` input so the POST
   * carries it through to the install pipeline. The Marfa side
   * appends `?credential_ref=…` when an existing OAuth provider
   * credential should be reused (e.g. installing `google.tasks` onto
   * an account that already authorized `google.calendar`). When
   * absent the form omits the field and the install pipeline behaves
   * as today (per-Connection credential, no reuse).
   *
   * The GET route validates the id resolves to a same-tenant
   * `system.credential` of `kind: oauth_token` before passing it
   * here; the renderer trusts that gate and just emits the value.
   */
  credentialRefHint?: string;
  /**
   * Optional human-readable label for the pre-arm hint, surfaced as
   * a small note above the Install button so the user can see which
   * credential they're about to reuse. Falls back to the credential
   * id when omitted.
   */
  credentialRefLabel?: string;
}

function describeDirection(direction: "read" | "write" | "both"): string {
  switch (direction) {
    case "read":
      return "Read-only — the connector will read from the external service into your Marfa tenant.";
    case "write":
      return "Write-only — the connector will write from your Marfa tenant out to the external service.";
    case "both":
      return "Two-way — the connector will read from and write to the external service.";
  }
}

/**
 * Short read/write summary for the capability tile description. The longer
 * `describeDirection` copy stays available in the Technical-details block;
 * this is the one-line "what it will do" the user sees first.
 */
function summarizeDirection(direction: "read" | "write" | "both"): string {
  switch (direction) {
    case "read":
      return "Read into your space.";
    case "write":
      return "Written out from your space.";
    case "both":
      return "Read and written both ways.";
  }
}

/**
 * The verb pair the connector exercises against each target type, expressed
 * in the scope grammar (`<type>:read` / `<type>:write`). `both` grants both.
 */
function directionVerbs(direction: "read" | "write" | "both"): string[] {
  switch (direction) {
    case "read":
      return ["read"];
    case "write":
      return ["write"];
    case "both":
      return ["read", "write"];
  }
}

function getTargetTypes(manifest: Record<string, unknown>): string[] {
  const targets = manifest.target_types;
  if (!Array.isArray(targets)) return [];
  return (targets as unknown[]).filter(
    (t): t is string => typeof t === "string",
  );
}

/**
 * Turn a dotted type identifier into a human data-type name for the
 * capability tile. `google.calendar.event` → "Calendar events"; `core.event`
 * → "Events". The qualifier segment (e.g. `calendar`) carries the specificity
 * the bare concrete type can't, so it's folded in — but a leading
 * provider/namespace root (`core`, `google`, the type's first segment) is
 * dropped, since the user doesn't need "Google calendar events", just
 * "Calendar events". This is the human name the prototype shows — distinct
 * from the raw `target_types` identifiers, which live verbatim in the
 * Technical-details block.
 */
function humanizeType(typeId: string): string {
  const segments = typeId.split(".").filter((s) => s.length > 0);
  // Drop the leading namespace root (provider or `core`); keep the rest.
  const meaningful = segments.length > 1 ? segments.slice(1) : segments;
  const words = meaningful.join(" ").replace(/_/g, " ").trim();
  if (words.length === 0) return typeId;
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return titled.endsWith("s") ? titled : `${titled}s`;
}

/**
 * The single human label for the capability tile. Multiple target types
 * collapse to a comma-joined list of their humanized names ("Events, Calendar
 * events"); a manifest with no target types falls back to a generic phrase so
 * the tile never renders empty.
 */
function leadLabel(types: string[]): string {
  if (types.length === 0) return "Your data";
  const names = Array.from(new Set(types.map(humanizeType)));
  return names.join(", ");
}

interface TriggerEntry {
  type: string;
  config?: { cron?: string };
}

/**
 * Triggers, rendered as a Technical-details sub-block. Kept so the disclosure
 * doesn't drop manifest information the flat layout used to show.
 */
function renderTriggerDetail(manifest: Record<string, unknown>): string {
  const triggers = manifest.triggers;
  if (!Array.isArray(triggers) || triggers.length === 0) return "";
  const lines = (triggers as TriggerEntry[]).map((t) => {
    const detail =
      t.type === "schedule" && t.config?.cron
        ? ` ${escapeHtml(t.config.cron)}`
        : "";
    return escapeHtml(t.type) + detail;
  });
  return `<p class="disclosure__micro">Triggers</p><div class="codefield">${lines.join("<br>")}</div>`;
}

/**
 * Additional extension / edge-type permissions, rendered as a Technical-details
 * sub-block. Preserves the information the flat "Additional permissions"
 * section used to carry.
 */
function renderPermissionDetail(manifest: Record<string, unknown>): string {
  const permissions = manifest.permissions as
    | {
        extension?: Record<string, "read" | "write">;
        edge?: Record<string, "read" | "write">;
      }
    | undefined;
  if (!permissions) return "";
  const lines: string[] = [];
  if (permissions.extension) {
    for (const [ns, level] of Object.entries(permissions.extension)) {
      lines.push(`${escapeHtml(ns)} — ${escapeHtml(level)}`);
    }
  }
  if (permissions.edge) {
    for (const [t, level] of Object.entries(permissions.edge)) {
      lines.push(`edge.${escapeHtml(t)} — ${escapeHtml(level)}`);
    }
  }
  if (lines.length === 0) return "";
  return `<p class="disclosure__micro">Additional permissions</p><div class="codefield">${lines.join("<br>")}</div>`;
}

export function renderInstallConsentScreen(params: ConsentParams): string {
  const targetTypes = getTargetTypes(params.manifest);
  const glyph = (params.manifestName.trim().charAt(0) || "?").toUpperCase();
  const verbs = directionVerbs(params.direction);

  // Type identifier(s): the raw, dotted identifiers from the manifest.
  const typeIdField =
    targetTypes.length > 0
      ? targetTypes.map((t) => escapeHtml(t)).join("<br>")
      : "—";

  // Scopes: each target type crossed with the direction verbs, in the
  // `<type>:<verb>` scope grammar. Falls back to the bare verbs when the
  // manifest declares no target types.
  const scopeTokens =
    targetTypes.length > 0
      ? targetTypes.flatMap((t) => verbs.map((v) => `${t}:${v}`))
      : verbs;
  const scopesField = scopeTokens
    .map((s) => escapeHtml(s))
    .join("&nbsp;&nbsp;");

  const bodyHtml = `
    <div class="apphead">
      <span class="logo" aria-hidden="true">${escapeHtml(glyph)}</span>
      <div>
        <div class="row__title">${escapeHtml(params.manifestName)}</div>
        <div class="row__meta">Marfa integration</div>
      </div>
    </div>
    <p class="sub">${escapeHtml(params.summary)}</p>

    <p class="eyebrow">Adds to your space</p>
    <div class="captile">
      <div class="captile__t">${escapeHtml(leadLabel(targetTypes))}</div>
      <div class="captile__d">${escapeHtml(summarizeDirection(params.direction))}</div>
    </div>

    <details class="disclosure">
      <summary><span class="disclosure__chevron" aria-hidden="true"></span> Technical details</summary>
      <div class="disclosure__body">
        <p class="disclosure__micro">Type identifier</p>
        <div class="codefield">${typeIdField}</div>
        <p class="disclosure__micro">Scopes</p>
        <div class="codefield">${scopesField}</div>
        <p class="disclosure__micro">Direction</p>
        <div class="codefield">${escapeHtml(describeDirection(params.direction))}</div>
        ${renderTriggerDetail(params.manifest)}
        ${renderPermissionDetail(params.manifest)}
      </div>
    </details>

    ${renderCredentialHint(params)}

    <form method="POST" action="/integrations/${escapeHtml(params.integrationId)}/install">
      ${renderCredentialRefInput(params)}
      <label class="field" style="margin-top:16px">
        <span class="field__label">Connection label</span>
        <input type="text" name="label" value="${escapeHtml(`${params.manifestName} ${params.manifestVersion}`)}">
      </label>
      <div class="actions">
        <button type="submit" name="decision" value="approve" class="btn btn--primary">Install</button>
        <button type="submit" name="decision" value="deny" class="btn btn--ghost">Cancel</button>
      </div>
    </form>
  `;

  return renderAuthLayout({
    title: `Install ${params.manifestName}`,
    bodyHtml,
  });
}

/** Surface the pre-arm note above the form so the user can see which
 *  existing credential the install will reuse. Returns "" when no
 *  pre-arm was passed (default install behavior, no UI shift). */
function renderCredentialHint(params: ConsentParams): string {
  if (!params.credentialRefHint) return "";
  const label = params.credentialRefLabel ?? params.credentialRefHint;
  return `<div class="banner banner--warn" role="note">Reusing existing OAuth credential: <strong>${escapeHtml(label)}</strong>. The install skips the credential-bootstrap step and reuses this one for the upstream OAuth flow.</div>`;
}

/** Hidden form field that carries the pre-arm through to the POST
 *  install route, which already accepts `credential_ref` as an
 *  optional form field (`routes/integrations.ts` performInstall call).
 *  Returns "" when no pre-arm — keeps the historic install body shape
 *  exactly. */
function renderCredentialRefInput(params: ConsentParams): string {
  if (!params.credentialRefHint) return "";
  return `<input type="hidden" name="credential_ref" value="${escapeHtml(params.credentialRefHint)}">`;
}
