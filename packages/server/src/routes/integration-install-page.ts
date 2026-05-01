/**
 * HTML consent screen for the integration install flow — Layer 2 PR 1.
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
      return "Read-only — the connector will read from the external service into your Myme tenant.";
    case "write":
      return "Write-only — the connector will write from your Myme tenant out to the external service.";
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
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    h2 { font-size: 0.875rem; margin: 0 0 8px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
    h3 { font-size: 0.875rem; margin: 8px 0 4px; color: #374151; }
    .publisher { color: #6b7280; font-size: 0.875rem; margin-bottom: 16px; }
    .summary { margin-bottom: 16px; line-height: 1.5; }
    .section { margin: 16px 0; padding: 12px; background: #f9fafb; border-radius: 8px; }
    .section ul { margin: 0; padding-left: 20px; }
    .section li { margin: 2px 0; }
    code { display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; color: #4b5563; background: #eef2ff; padding: 1px 6px; border-radius: 4px; }
    .label-input { display: block; width: 100%; padding: 8px; margin-top: 4px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.875rem; box-sizing: border-box; }
    .actions { display: flex; gap: 12px; margin-top: 24px; }
    button { padding: 10px 20px; border-radius: 6px; font-size: 0.875rem; cursor: pointer; border: 1px solid #d1d5db; }
    .approve { background: #2563eb; color: white; border-color: #2563eb; }
    .deny { background: white; color: #374151; }
    .direction { font-style: italic; color: #4b5563; }
  </style>
</head>
<body>
  <h1>Install ${escapeHtml(params.manifestName)} <code>${escapeHtml(params.manifestVersion)}</code></h1>
  <div class="publisher">by ${escapeHtml(params.publisher)}</div>
  <p class="summary">${escapeHtml(params.summary)}</p>
  <p class="direction">${escapeHtml(describeDirection(params.direction))}</p>

  ${renderTargetTypes(params.manifest)}
  ${renderTriggers(params.manifest)}
  ${renderPermissions(params.manifest)}

  <form method="POST" action="/integrations/${escapeHtml(params.integrationId)}/install">
    <div class="section">
      <h2>Connection label</h2>
      <input class="label-input" type="text" name="label" value="${escapeHtml(`${params.manifestName} ${params.manifestVersion}`)}">
    </div>
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="approve">Install</button>
      <button type="submit" name="decision" value="deny" class="deny">Cancel</button>
    </div>
  </form>
</body>
</html>`;
}
