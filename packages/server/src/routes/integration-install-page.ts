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
   * an account that already authorised `google.calendar`). When
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

interface TriggerEntry {
  type: string;
  config?: { cron?: string };
}

function renderTriggers(manifest: Record<string, unknown>): string {
  const triggers = manifest.triggers;
  if (!Array.isArray(triggers) || triggers.length === 0) return "";
  const items = (triggers as TriggerEntry[]).map((t) => {
    const detail =
      t.type === "schedule" && t.config?.cron
        ? ` <code>${escapeHtml(t.config.cron)}</code>`
        : "";
    return `<li>${escapeHtml(t.type)}${detail}</li>`;
  });
  return `<div class="section"><h2>Triggers</h2><ul>${items.join("")}</ul></div>`;
}

function renderTargetTypes(manifest: Record<string, unknown>): string {
  const targets = manifest.target_types;
  if (!Array.isArray(targets) || targets.length === 0) return "";
  const items = (targets as string[]).map(
    (t) => `<li><code>${escapeHtml(t)}</code></li>`,
  );
  return `<div class="section"><h2>Item types it touches</h2><ul>${items.join("")}</ul></div>`;
}

function renderPermissions(manifest: Record<string, unknown>): string {
  const permissions = manifest.permissions as
    | {
        extension?: Record<string, "read" | "write">;
        edge?: Record<string, "read" | "write">;
      }
    | undefined;
  if (!permissions) return "";
  const blocks: string[] = [];
  if (permissions.extension && Object.keys(permissions.extension).length > 0) {
    const items = Object.entries(permissions.extension).map(
      ([ns, level]) =>
        `<li><code>${escapeHtml(ns)}</code> — ${escapeHtml(level)}</li>`,
    );
    blocks.push(`<h3>Extension namespaces</h3><ul>${items.join("")}</ul>`);
  }
  if (permissions.edge && Object.keys(permissions.edge).length > 0) {
    const items = Object.entries(permissions.edge).map(
      ([t, level]) =>
        `<li><code>${escapeHtml(t)}</code> — ${escapeHtml(level)}</li>`,
    );
    blocks.push(`<h3>Edge types</h3><ul>${items.join("")}</ul>`);
  }
  if (blocks.length === 0) return "";
  return `<div class="section"><h2>Additional permissions</h2>${blocks.join("")}</div>`;
}

export function renderInstallConsentScreen(params: ConsentParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install ${escapeHtml(params.manifestName)}</title>
  <style>
    /* Standalone consent surface — mirrors the monochrome "Luma" look of
       /auth/static/auth.css without importing it (this page renders its
       own document rather than via renderAuthLayout). Light-only. */
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #f4f4f5; color: #0f0f0f; margin: 0; padding: 32px 20px; -webkit-font-smoothing: antialiased; }
    .card { max-width: 480px; margin: 0 auto; background: #ffffff; border: 1px solid #ececea; border-radius: 16px; padding: 28px; box-shadow: 0 1px 2px rgba(15, 15, 15, 0.03), 0 12px 36px rgba(15, 15, 15, 0.05); }
    h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3; margin: 0 0 6px; }
    h2 { font-size: 12px; margin: 0 0 8px; color: #9b9b96; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    h3 { font-size: 13px; margin: 10px 0 4px; color: #5a5a55; font-weight: 600; }
    .publisher { color: #5a5a55; font-size: 14px; margin: 0 0 16px; }
    .summary { margin: 0 0 8px; line-height: 1.55; font-size: 14px; }
    .direction { margin: 0 0 4px; color: #5a5a55; font-size: 13px; }
    .section { margin: 16px 0; padding-top: 14px; border-top: 1px solid #f1f1ee; }
    .section ul { margin: 0; padding-left: 18px; }
    .section li { margin: 3px 0; font-size: 14px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #6a6a64; background: #f1f1ee; padding: 1px 6px; border-radius: 4px; }
    .label-input { display: block; width: 100%; padding: 10px 12px; margin-top: 6px; border: 1px solid transparent; border-radius: 10px; background: #f3f3f4; font-size: 16px; color: #0f0f0f; }
    .label-input:focus { outline: none; border-color: #0f0f0f; box-shadow: 0 0 0 3px rgba(15, 15, 15, 0.08); }
    .actions { display: flex; flex-direction: column; gap: 8px; margin-top: 24px; }
    button { width: 100%; min-height: 40px; padding: 10px 16px; border-radius: 10px; font-size: 14px; font-weight: 500; cursor: pointer; border: 1px solid #d9d9d4; font-family: inherit; }
    .approve { background: #0f0f0f; color: #ffffff; border-color: #0f0f0f; }
    .deny { background: transparent; color: #5a5a55; border-color: transparent; }
    .deny:hover { background: #f1f1ee; color: #0f0f0f; }
    .credential-hint { margin: 16px 0; padding: 12px 14px; background: #f4f4f5; border: 1px solid #ececea; border-radius: 10px; font-size: 13px; color: #5a5a55; }
    .credential-hint code { background: #ececea; color: #0f0f0f; }
  </style>
</head>
<body>
  <main class="card">
  <h1>Install ${escapeHtml(params.manifestName)} <code>${escapeHtml(params.manifestVersion)}</code></h1>
  <div class="publisher">by ${escapeHtml(params.publisher)}</div>
  <p class="summary">${escapeHtml(params.summary)}</p>
  <p class="direction">${escapeHtml(describeDirection(params.direction))}</p>

  ${renderTargetTypes(params.manifest)}
  ${renderTriggers(params.manifest)}
  ${renderPermissions(params.manifest)}

  ${renderCredentialHint(params)}

  <form method="POST" action="/integrations/${escapeHtml(params.integrationId)}/install">
    ${renderCredentialRefInput(params)}
    <div class="section">
      <h2>Connection label</h2>
      <input class="label-input" type="text" name="label" value="${escapeHtml(`${params.manifestName} ${params.manifestVersion}`)}">
    </div>
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="approve">Install</button>
      <button type="submit" name="decision" value="deny" class="deny">Cancel</button>
    </div>
  </form>
  </main>
</body>
</html>`;
}

/** Surface the pre-arm note above the form so the user can see which
 *  existing credential the install will reuse. Returns "" when no
 *  pre-arm was passed (default install behaviour, no UI shift). */
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
