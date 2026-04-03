import type { ParsedScope } from "@mymehq/shared";

interface ConsentParams {
  clientName: string;
  scopes: ParsedScope[];
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  responseType: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the OAuth consent screen as an HTML string. */
export function renderConsentScreen(params: ConsentParams): string {
  const readScopes = params.scopes.filter((s) => s.operation === "read");
  const writeScopes = params.scopes.filter((s) => s.operation === "write");

  const scopeCheckbox = (scope: ParsedScope) =>
    `<label style="display:block;margin:4px 0">
      <input type="checkbox" name="scopes" value="${escapeHtml(scope.typePattern)}:${escapeHtml(scope.operation)}" checked>
      ${escapeHtml(scope.typePattern)} (${escapeHtml(scope.operation)})
    </label>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${escapeHtml(params.clientName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    .app-name { font-weight: 600; color: #2563eb; }
    .section { margin: 16px 0; padding: 12px; background: #f9fafb; border-radius: 8px; }
    .section h2 { font-size: 0.875rem; margin: 0 0 8px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
    .actions { display: flex; gap: 12px; margin-top: 24px; }
    button { padding: 10px 20px; border-radius: 6px; font-size: 0.875rem; cursor: pointer; border: 1px solid #d1d5db; }
    .approve { background: #2563eb; color: white; border-color: #2563eb; }
    .deny { background: white; color: #374151; }
  </style>
</head>
<body>
  <h1><span class="app-name">${escapeHtml(params.clientName)}</span> wants to access your data</h1>
  <form method="POST" action="/auth/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}">
    <input type="hidden" name="state" value="${escapeHtml(params.state)}">
    <input type="hidden" name="response_type" value="${escapeHtml(params.responseType)}">

    ${
      readScopes.length > 0
        ? `<div class="section">
            <h2>Read access</h2>
            ${readScopes.map(scopeCheckbox).join("\n")}
          </div>`
        : ""
    }

    ${
      writeScopes.length > 0
        ? `<div class="section">
            <h2>Read and write access</h2>
            ${writeScopes.map(scopeCheckbox).join("\n")}
          </div>`
        : ""
    }

    <div class="actions">
      <button type="submit" name="action" value="approve" class="approve">Approve</button>
      <button type="submit" name="action" value="deny" class="deny">Deny</button>
    </div>
  </form>
</body>
</html>`;
}
