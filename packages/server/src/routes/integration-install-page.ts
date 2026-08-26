/**
 * HTML consent screen for the integration install flow.
 *
 * Renders through the shared auth layout (`renderAuthLayout` +
 * `/auth/static/auth.css`) so it tracks the same locked language as every
 * other auth surface — no duplicated inline stylesheet. The capability the
 * integration adds sits in a soft tile; the raw type identifiers and scope
 * strings live behind a collapsed "Technical details" disclosure (hidden by
 * default); the actions are stacked pill buttons.
 *
 * Distinct from OAuth consent because the granted scopes come from the
 * manifest, not OAuth client registration, and there's no PKCE round-trip —
 * the install posts straight back to the same path with a `decision` field
 * (approve | deny).
 *
 * The app tile is deliberately neutral: the manifest carries no icon or
 * brand-color field, so a soft tile with a dark glyph is the honest
 * representation.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { renderConfigurationFields } from "./connection-configure.js";
import { escapeHtml } from "./auth-html.js";
import { manifestDisplay } from "./manifest-display.js";

interface ConsentParams {
  integrationId: string;
  manifestName: string;
  manifestVersion: string;
  publisher: string;
  summary: string;
  direction: "read" | "write" | "both";
  manifest: Record<string, unknown>;
  /**
   * Values to pre-fill the configuration fields with — the user's own
   * submission, threaded back when validation refuses it so nothing they
   * typed is lost. Empty on first render.
   */
  configurationValues?: Record<string, unknown>;
  /** Validation refusal from a previous submit, rendered as a banner. */
  errorMessage?: string;
  /**
   * Optional pre-arm: id of a same-space `system.credential` of
   * `kind: oauth_token` the caller wants the install to reuse. When
   * set the form renders a hidden `credential_ref` input so the POST
   * carries it through to the install pipeline. The Marfa side
   * appends `?credential_ref=…` when an existing OAuth provider
   * credential should be reused (e.g. installing `google/tasks` onto
   * an account that already authorized `google/calendar`). When
   * absent the form omits the field and the install pipeline behaves
   * as today (per-Connection credential, no reuse).
   *
   * The GET route validates the id resolves to a same-space
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
  // Direction describes flow relative to the external service, never an
  // access level: an inbound integration writes what it finds into your
  // space, so the copy says so rather than claiming "read-only" for a
  // credential that holds write on every declared type.
  switch (direction) {
    case "read":
      return "Brings content in. It reads from the other service and writes what it finds into your space.";
    case "write":
      return "Sends content out. It reads from your space and writes to the other service.";
    case "both":
      return "Two-way. A change on either side is written to the other.";
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
      return "Brought into your space.";
    case "write":
      return "Sent out from your space.";
    case "both":
      return "Synced both ways.";
  }
}

/**
 * The verbs the minted credential actually holds against each target type,
 * expressed in the scope grammar. Every declared target type is granted
 * write whatever the direction — an inbound integration writes what it
 * pulls into Marfa — so the consent surface says write, matching the
 * credential rather than the flow description.
 */
function directionVerbs(direction: "read" | "write" | "both"): string[] {
  void direction;
  return ["write"];
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
      lines.push(`${escapeHtml(ns)}: ${escapeHtml(level)}`);
    }
  }
  if (permissions.edge) {
    for (const [t, level] of Object.entries(permissions.edge)) {
      lines.push(`edge.${escapeHtml(t)}: ${escapeHtml(level)}`);
    }
  }
  if (lines.length === 0) return "";
  return `<p class="disclosure__micro">Additional permissions</p><div class="codefield">${lines.join("<br>")}</div>`;
}

export function renderInstallConsentScreen(params: ConsentParams): string {
  const targetTypes = getTargetTypes(params.manifest);
  const display = manifestDisplay(
    params.manifestName,
    params.manifest.display_name,
  );
  const verbs = directionVerbs(params.direction);

  // A display name is free text its publisher chose, and every other line
  // above the Install button (the summary, the description) is too. The
  // identifier is not, so it stays on the page whenever a label is what the
  // heading holds: it is what separates `acme/calendar-sync` from somebody
  // else's integration calling itself the same words.
  //
  // It has to say so, though. `display_name` carries no character class, so
  // a publisher may declare one shaped exactly like an identifier, and a
  // screen showing two identifier-shaped strings with neither announced
  // leaves the authoritative one as the smaller and lower of the two.
  //
  // The lead-in qualifies the identifier rather than replacing anything:
  // "Marfa integration" is the only token on this line establishing the
  // platform, rather than the publisher, as the one speaking, and the case
  // that most needs to sound like the platform is exactly the one where a
  // publisher-chosen string has taken the heading. So the labeled branch is
  // the unlabeled line with the identifier inserted, and with no label the
  // line reads as it always has.
  const metaLead = display.labeled
    ? `Marfa integration ${display.identifier}`
    : "Marfa integration";

  // Type identifier(s): the raw, dotted identifiers from the manifest.
  const typeIdField =
    targetTypes.length > 0
      ? targetTypes.map((t) => escapeHtml(t)).join("<br>")
      : "None";

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
      <span class="logo" aria-hidden="true">${escapeHtml(display.glyph)}</span>
      <div>
        <div class="row__title">${escapeHtml(display.name)}</div>
        <div class="row__meta">${escapeHtml(metaLead)}, version ${escapeHtml(params.manifestVersion)}</div>
      </div>
    </div>
    <p class="sub">${escapeHtml(params.summary)}</p>

    <p class="lsec">Adds to your space</p>
    <div class="captile">
      <div class="captile__t">${escapeHtml(leadLabel(targetTypes))}</div>
      <div class="captile__d">${escapeHtml(summarizeDirection(params.direction))}</div>
    </div>

    <details class="disclosure">
      <summary><span class="disclosure__chevron" aria-hidden="true"></span> Details</summary>
      <div class="disclosure__body">
        <p class="disclosure__micro">Kind of content</p>
        <div class="codefield">${typeIdField}</div>
        <p class="disclosure__micro">Permissions</p>
        <div class="codefield">${scopesField}</div>
        <p class="disclosure__micro">Direction</p>
        <div class="codefield">${escapeHtml(describeDirection(params.direction))}</div>
        ${renderTriggerDetail(params.manifest)}
        ${renderPermissionDetail(params.manifest)}
      </div>
    </details>

    ${renderCredentialHint(params)}
    ${params.errorMessage ? `<div class="banner banner--error" role="alert">${escapeHtml(params.errorMessage)}</div>` : ""}

    <form method="POST" action="/integrations/${escapeHtml(params.integrationId)}/install">
      ${renderCredentialRefInput(params)}
      ${renderInstallConfiguration(params)}
      <div class="actions">
        <button type="submit" name="decision" value="approve" class="btn btn--primary">Install</button>
        <button type="submit" name="decision" value="deny" class="btn btn--ghost">Cancel</button>
      </div>
    </form>
  `;

  return renderAuthLayout({
    title: `Install ${display.name}`,
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

/**
 * The manifest's declared configuration, rendered inside the install form
 * so an integration whose contract requires a value can be installed from
 * its own consent screen — previously the form sent no configuration at
 * all, and a required key with no default made this page a dead end with
 * a bare 400 behind the Install button. Field names carry the
 * `config_` prefix so a manifest key can never collide with the form's
 * own fields.
 */
export const INSTALL_CONFIG_FIELD_PREFIX = "config_";

function renderInstallConfiguration(params: ConsentParams): string {
  const manifest = params.manifest as {
    configuration_schema?: Record<string, unknown>;
  };
  if (
    !manifest.configuration_schema ||
    Object.keys(manifest.configuration_schema).length === 0
  ) {
    return "";
  }
  const fields = renderConfigurationFields(
    params.manifest as unknown as Parameters<
      typeof renderConfigurationFields
    >[0],
    params.configurationValues ?? {},
    { namePrefix: INSTALL_CONFIG_FIELD_PREFIX },
  );
  return `<p class="lsec" style="margin-top:16px">Configuration</p>${fields}`;
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
