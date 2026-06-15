/**
 * HTML consent screen for the integration install flow.
 *
 * Mirrors the OAuth consent screen pattern in routes/consent.ts:
 *   - Server-rendered HTML with inline CSS, no JS.
 *   - Single POST form back to the same path with a `decision` field
 *     (approve | deny) plus optional label override.
 *
 * Distinct from OAuth consent because:
 *   - The granted scopes here come from the manifest, not OAuth client
 *     registration. The user sees what the connector will do (direction,
 *     target types, triggers) rather than scope strings.
 *   - There's no PKCE round-trip — the install doesn't redirect back to
 *     a third-party app; the next page is server-rendered too.
 *
 * The surface is self-contained (its own inline <style>) but tracks the
 * shared "Luma" auth stylesheet (auth-static/auth-css.ts) for tokens and
 * the `.disclosure` / `.codefield` patterns. The app tile is deliberately
 * neutral: the manifest carries no icon or brand-color field, so a gray
 * tile with a dark glyph is the honest representation. Light + dark via the
 * same token flip the shared sheet uses.
 */

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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
 * Short read/write summary for the human lead-row description. The longer
 * `describeDirection` copy stays available (and is what the disclosure-free
 * paths surface); this is the one-line "what it will do" the user sees first.
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
 * Turn a dotted type identifier into a human data-type name for the lead row.
 * `google.calendar.event` → "Calendar events"; `core.event` → "Events". The
 * qualifier segment (e.g. `calendar`) carries the specificity the bare concrete
 * type can't, so it's folded in — but a leading provider/namespace root
 * (`core`, `google`, the type's first segment) is dropped, since the user
 * doesn't need "Google calendar events", just "Calendar events". This is the
 * human name the prototype shows — distinct from the raw `target_types`
 * identifiers, which live verbatim in the Technical-details block.
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
 * The single human label for the lead row. Multiple target types collapse to
 * a comma-joined list of their humanized names ("Events, Calendar events");
 * a manifest with no target types falls back to a generic phrase so the row
 * never renders empty.
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
  return `<p class="micro">Triggers</p><div class="codefield">${lines.join("<br>")}</div>`;
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
  return `<p class="micro">Additional permissions</p><div class="codefield">${lines.join("<br>")}</div>`;
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install ${escapeHtml(params.manifestName)}</title>
  <style>
    /* Standalone consent surface — tracks the monochrome "Luma" look of
       auth-static/auth-css.ts (tokens, .disclosure, .codefield) without
       importing it, since this page renders its own document rather than
       via renderAuthLayout. Dark mode follows the device. */
    :root {
      color-scheme: light dark;
      --bg: #f5f5f5;
      --card: #ffffff;
      --fg: #0a0a0a;
      --fg-muted: #737373;
      --fg-faint: #a3a3a3;
      --border: #e5e5e5;
      --border-strong: #d4d4d4;
      --hairline: #ededed;
      --surface-2: #f5f5f5;
      --field: #f5f5f5;
      --field-hover: #ececec;
      --primary: #171717;
      --primary-hover: #2a2a2a;
      --primary-fg: #fafafa;
      --ring: rgba(10, 10, 10, 0.13);
      --r-pill: 999px;
      --r-card: 26px;
      --r-md: 14px;
      --shadow: 0 1px 2px rgba(10, 10, 10, 0.04), 0 8px 28px rgba(10, 10, 10, 0.06);
      --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0a0a;
        --card: #161616;
        --fg: #fafafa;
        --fg-muted: #a3a3a3;
        --fg-faint: #6e6e6e;
        --border: #2a2a2a;
        --border-strong: #3a3a3a;
        --hairline: #242424;
        --surface-2: #1f1f1f;
        --field: #232323;
        --field-hover: #2b2b2b;
        --primary: #fafafa;
        --primary-hover: #e5e5e5;
        --primary-fg: #171717;
        --ring: rgba(250, 250, 250, 0.2);
        --shadow: none;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      padding: 40px 20px;
      display: grid;
      place-items: center;
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .card {
      width: 100%;
      max-width: 460px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--r-card);
      padding: 28px;
      box-shadow: var(--shadow);
    }
    @media (max-width: 460px) {
      body { padding: 16px; }
      .card { padding: 22px; border-radius: 20px; }
    }

    /* App header — neutral tile (NO brand color), name + "Marfa integration". */
    .app { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
    .app__logo {
      width: 46px; height: 46px;
      border-radius: var(--r-md);
      background: var(--surface-2);
      border: 1px solid var(--border);
      display: grid; place-items: center;
      color: var(--fg);
      font-size: 20px; font-weight: 600;
      letter-spacing: -0.01em;
      flex-shrink: 0;
    }
    .app__name { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
    .app__by { font-size: 13px; color: var(--fg-muted); }
    .subtitle { margin: 0 0 6px; font-size: 14px; line-height: 1.55; color: var(--fg-muted); }

    .eyebrow {
      margin: 18px 0 8px;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--fg-faint);
    }

    /* Lead row — neutral icon tile + bold human name + muted description. */
    .lead { display: flex; align-items: flex-start; gap: 13px; }
    .lead__ic {
      display: grid; place-items: center;
      width: 40px; height: 40px;
      border-radius: 11px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--fg-muted);
      flex-shrink: 0;
    }
    .lead__name { font-size: 15px; font-weight: 600; display: block; color: var(--fg); }
    .lead__desc { font-size: 13px; color: var(--fg-muted); }

    /* Disclosure — copied from the shared sheet's .disclosure pattern, with
       NO top divider line (the prototype's flush "Technical details"). */
    details.disclosure { margin-top: 16px; }
    details.disclosure > summary {
      list-style: none;
      display: flex; align-items: center; gap: 8px;
      padding: 12px 0;
      cursor: pointer;
      color: var(--fg-muted);
      font-size: 13px; font-weight: 500;
    }
    details.disclosure > summary::-webkit-details-marker { display: none; }
    .disclosure__chevron {
      width: 8px; height: 8px;
      border-right: 1.6px solid currentColor;
      border-bottom: 1.6px solid currentColor;
      transform: rotate(-45deg);
      transition: transform 0.18s var(--ease);
    }
    details.disclosure[open] > summary { color: var(--fg); }
    details.disclosure[open] > summary .disclosure__chevron { transform: rotate(45deg); }
    .disclosure__body { padding: 4px 0 8px; }
    .micro {
      margin: 12px 0 6px;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--fg-faint);
    }
    .micro:first-child { margin-top: 4px; }

    .codefield {
      width: 100%;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px; line-height: 1.5;
      padding: 11px 14px;
      color: var(--fg-muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      word-break: break-all;
    }

    /* Connection label input — pill field per the shared sheet. */
    .field { display: flex; flex-direction: column; gap: 7px; }
    .field__label { font-size: 13px; font-weight: 500; color: var(--fg); }
    .label-input {
      width: 100%;
      font-family: inherit;
      /* 16px so iOS Safari doesn't auto-zoom on focus. */
      font-size: 16px; line-height: 1.4;
      padding: 11px 16px;
      color: var(--fg);
      background: var(--field);
      border: 1px solid transparent;
      border-radius: var(--r-pill);
      transition: background 0.12s var(--ease), border-color 0.12s var(--ease), box-shadow 0.12s var(--ease);
    }
    .label-input:hover { background: var(--field-hover); }
    .label-input:focus {
      outline: none;
      background: var(--card);
      border-color: var(--fg);
      box-shadow: 0 0 0 3px var(--ring);
    }

    .credential-hint {
      margin: 16px 0;
      padding: 12px 14px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      font-size: 13px; color: var(--fg-muted);
    }
    .credential-hint code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--fg);
      background: var(--field-hover);
      padding: 2px 7px;
      border-radius: 6px;
    }

    /* Stacked actions — pill buttons. */
    .stack { display: flex; flex-direction: column; gap: 12px; margin-top: 22px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 100%;
      min-height: 44px;
      padding: 11px 20px;
      font-family: inherit;
      font-size: 14px; font-weight: 600; line-height: 1;
      border: 1px solid transparent;
      border-radius: var(--r-pill);
      cursor: pointer;
      transition: background 0.12s var(--ease), border-color 0.12s var(--ease), transform 0.06s var(--ease);
    }
    .btn:active { transform: translateY(0.5px); }
    .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
    .btn--primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
    .btn--primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    .btn--outline { background: var(--card); color: var(--fg); border-color: var(--border); }
    .btn--outline:hover { background: var(--surface-2); border-color: var(--border-strong); }

    .footnote { margin: 18px 0 0; text-align: center; font-size: 12px; color: var(--fg-faint); }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition-duration: 0.001ms !important; }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="app">
      <span class="app__logo" aria-hidden="true">${escapeHtml(glyph)}</span>
      <span>
        <span class="app__name">${escapeHtml(params.manifestName)}</span><br>
        <span class="app__by">Marfa integration</span>
      </span>
    </div>
    <p class="subtitle">${escapeHtml(params.summary)}</p>

    <p class="eyebrow">Adds to your space</p>
    <div class="lead">
      <span class="lead__ic" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      </span>
      <span>
        <b class="lead__name">${escapeHtml(leadLabel(targetTypes))}</b>
        <span class="lead__desc">${escapeHtml(summarizeDirection(params.direction))}</span>
      </span>
    </div>

    <details class="disclosure">
      <summary><span class="disclosure__chevron"></span> Technical details</summary>
      <div class="disclosure__body">
        <p class="micro">Type identifier</p>
        <div class="codefield">${typeIdField}</div>
        <p class="micro">Scopes</p>
        <div class="codefield">${scopesField}</div>
        <p class="micro">Direction</p>
        <div class="codefield">${escapeHtml(describeDirection(params.direction))}</div>
        ${renderTriggerDetail(params.manifest)}
        ${renderPermissionDetail(params.manifest)}
      </div>
    </details>

    ${renderCredentialHint(params)}

    <form method="POST" action="/integrations/${escapeHtml(params.integrationId)}/install">
      ${renderCredentialRefInput(params)}
      <div class="field" style="margin-top:16px">
        <label class="field__label" for="label">Connection label</label>
        <input class="label-input" id="label" type="text" name="label" value="${escapeHtml(`${params.manifestName} ${params.manifestVersion}`)}">
      </div>
      <div class="stack">
        <button type="submit" name="decision" value="approve" class="btn btn--primary">Install</button>
        <button type="submit" name="decision" value="deny" class="btn btn--outline">Cancel</button>
      </div>
    </form>
    <p class="footnote">Remove anytime in Settings → Connections.</p>
  </main>
</body>
</html>`;
}

/** Surface the pre-arm note above the form so the user can see which
 *  existing credential the install will reuse. Returns "" when no
 *  pre-arm was passed (default install behavior, no UI shift). */
function renderCredentialHint(params: ConsentParams): string {
  if (!params.credentialRefHint) return "";
  const label = params.credentialRefLabel ?? params.credentialRefHint;
  return `<div class="credential-hint">Reusing existing OAuth credential: <code>${escapeHtml(label)}</code>. The install will skip the credential-bootstrap step and reuse this one for the upstream OAuth dance.</div>`;
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
