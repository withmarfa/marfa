/**
 * OAuth consent screen renderer.
 *
 * Wave C PR4: layout extraction. Older inline `<style>` block dropped
 * in favour of the shared `/auth/static/auth.css` design tokens —
 * unifies the visual surface with sign-in / sign-up / device-flow
 * (single dark-ink primary instead of the old blue accent). Class
 * names migrate to the shared system (`.section`, `.scope-row`,
 * `.scope-literal`, `.scope-human`, `.actions`, `.btn--primary`,
 * `.btn`).
 *
 * PR5 will extend this with re-consent diff rendering (kept / added /
 * removed sections) when a prior `system.connection user-app-grant`
 * for `(user, client_id)` exists.
 */

import type { ParsedScope } from "@mymehq/shared";
import { renderAuthLayout } from "./auth-layout.js";

interface ConsentParams {
  clientName: string;
  scopes: ParsedScope[];
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  responseType: string;
  /**
   * Plain-English description per scope, keyed by `typePattern` (e.g.
   * `core.note` → "Text content you created."). Pulled from the type
   * registry's `description` field at the call site. Missing entries
   * fall back to the literal scope.
   */
  descriptions?: Record<string, string>;
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

  const descriptionFor = (scope: ParsedScope): string | undefined => {
    return params.descriptions?.[scope.typePattern];
  };

  const scopeCheckbox = (scope: ParsedScope) => {
    const literal = `${scope.typePattern}:${scope.operation}`;
    const description = descriptionFor(scope);
    const humanLine = description
      ? `<span class="scope-human">${escapeHtml(description)}</span>`
      : "";
    return `<label class="scope-row">
      <input type="checkbox" name="scopes" value="${escapeHtml(literal)}" checked>
      <code class="scope-literal">${escapeHtml(literal)}</code>
      ${humanLine}
    </label>`;
  };

  const safeClient = escapeHtml(params.clientName);
  const safeClientId = escapeHtml(params.clientId);
  const safeRedirectUri = escapeHtml(params.redirectUri);
  const safeCodeChallenge = escapeHtml(params.codeChallenge);
  const safeCodeChallengeMethod = escapeHtml(params.codeChallengeMethod);
  const safeState = escapeHtml(params.state);
  const safeResponseType = escapeHtml(params.responseType);

  const readSection =
    readScopes.length > 0
      ? `<div class="section">
          <h2>Read access</h2>
          ${readScopes.map(scopeCheckbox).join("\n")}
        </div>`
      : "";

  const writeSection =
    writeScopes.length > 0
      ? `<div class="section">
          <h2>Read and write access</h2>
          ${writeScopes.map(scopeCheckbox).join("\n")}
        </div>`
      : "";

  const bodyHtml = `
    <h1><span class="client-name">${safeClient}</span> wants to access your data</h1>
    <form method="POST" action="/auth/authorize">
      <input type="hidden" name="client_id" value="${safeClientId}">
      <input type="hidden" name="redirect_uri" value="${safeRedirectUri}">
      <input type="hidden" name="code_challenge" value="${safeCodeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${safeCodeChallengeMethod}">
      <input type="hidden" name="state" value="${safeState}">
      <input type="hidden" name="response_type" value="${safeResponseType}">

      ${readSection}
      ${writeSection}

      <div class="actions">
        <button type="submit" name="action" value="approve" class="btn btn--primary">Approve</button>
        <button type="submit" name="action" value="deny" class="btn">Deny</button>
      </div>
    </form>
  `;

  return renderAuthLayout({
    title: `Authorize ${params.clientName}`,
    bodyHtml,
    wide: true,
  });
}
