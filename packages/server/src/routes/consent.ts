/**
 * OAuth consent screen renderer.
 *
 * Wave C PR4: layout extraction. Older inline `<style>` block dropped
 * in favour of the shared `/auth/static/auth.css` design tokens —
 * unifies the visual surface with sign-in / sign-up / device-flow.
 *
 * Wave C PR5 / T-032: re-consent diff. When the caller passes
 * `priorScopes` (the scope set the user previously approved on this
 * client, looked up via `system.connection` of `kind: app`),
 * the screen renders three group blocks — Previously granted (kept),
 * New permissions (added), and No longer requested (removed) —
 * instead of the flat read / write split. First-time consent (no
 * prior grant) keeps the flat shape.
 *
 * T-131 rewrite: the homegrown surface used to POST the consent form
 * to `/auth/authorize` to mint the authorization code AT consent time.
 * The @better-auth/oauth-provider plugin inverts this — it mints the
 * `code` BEFORE redirecting to the consent page and expects the form to
 * POST back to `/auth/oauth2/consent` with `code` + `accept` + `scope`.
 * PKCE / state / redirect_uri / response_type are bound to the code
 * server-side; the form no longer carries them.
 */

import type { ParsedScope } from "@mymehq/shared";
import { renderAuthLayout } from "./auth-layout.js";
import { computeConsentDiff } from "./consent-diff.js";

interface ConsentParams {
  clientName: string;
  scopes: ParsedScope[];
  clientId: string;
  /**
   * The authorization code the plugin pre-minted before redirecting
   * here. Threaded back into `/auth/oauth2/consent` as the binding
   * handle for accept/deny.
   */
  code: string;
  /**
   * Plain-English description per scope, keyed by `typePattern` (e.g.
   * `core.note` → "Text content you created."). Pulled from the type
   * registry's `description` field at the call site. Missing entries
   * fall back to the literal scope.
   */
  descriptions?: Record<string, string>;
  /**
   * Wave C PR5: the literal scope set the user previously approved on
   * this client (e.g. `["core.note:read", "core.note:write"]`). When
   * present, the screen renders the diff variant — "Previously
   * granted" / "New permissions" / "No longer requested" — instead of
   * the flat read / write split. When absent (first-time consent or
   * no prior grant), renders flat.
   */
  priorScopes?: readonly string[];
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
  const descriptionFor = (typePattern: string): string | undefined =>
    params.descriptions?.[typePattern];

  // The "removed" branch only carries literals (no `ParsedScope`),
  // since we render them as-is without splitting on read/write.
  const scopeCheckbox = (scope: ParsedScope, opts?: { checked?: boolean }) => {
    const literal =
      scope.kind === "oidc"
        ? (scope.oidcScope ?? scope.typePattern)
        : `${scope.typePattern}:${scope.operation}`;
    const description = descriptionFor(scope.typePattern);
    const humanLine = description
      ? `<span class="scope-human">${escapeHtml(description)}</span>`
      : "";
    const checked = opts?.checked === false ? "" : "checked";
    return `<label class="scope-row">
      <input type="checkbox" name="scopes" value="${escapeHtml(literal)}" ${checked}>
      <code class="scope-literal">${escapeHtml(literal)}</code>
      ${humanLine}
    </label>`;
  };

  // For the "removed" rows we don't have a parsed shape — but we know
  // every scope literal is `<typePattern>:<verb>`. Split on the LAST
  // `:` so a typePattern containing `:` (rare today, future-proofing)
  // still parses cleanly.
  const removedRow = (literal: string): string => {
    const lastColon = literal.lastIndexOf(":");
    const typePattern = lastColon > 0 ? literal.slice(0, lastColon) : literal;
    const description = descriptionFor(typePattern);
    const humanLine = description
      ? `<span class="scope-human">${escapeHtml(description)}</span>`
      : "";
    return `<div class="scope-row scope-row--removed">
      <code class="scope-literal">${escapeHtml(literal)}</code>
      ${humanLine}
    </div>`;
  };

  const safeClient = escapeHtml(params.clientName);
  const safeClientId = escapeHtml(params.clientId);
  const safeCode = escapeHtml(params.code);

  // Decide diff-vs-flat rendering. Diff path triggers when caller
  // passed `priorScopes` and there's at least one scope on either
  // side — empty-prior + empty-next never happens (we'd have rejected
  // earlier), and a single-empty side trivially collapses to flat.
  const showDiff = params.priorScopes !== undefined;

  let scopesHtml: string;
  if (showDiff) {
    // Compute diff against literal scope strings (`<type>:<verb>` or bare OIDC literal).
    const scopeLiteral = (s: ParsedScope) =>
      s.kind === "oidc"
        ? (s.oidcScope ?? s.typePattern)
        : `${s.typePattern}:${s.operation}`;
    const nextLiterals = params.scopes.map(scopeLiteral);
    const diff = computeConsentDiff(params.priorScopes ?? [], nextLiterals);
    // Re-hydrate the kept / added literals back to ParsedScopes so
    // the renderer can split read/write description lookup. Map by
    // literal back to the input.
    const parsedByLiteral = new Map<string, ParsedScope>();
    for (const scope of params.scopes) {
      parsedByLiteral.set(scopeLiteral(scope), scope);
    }
    const keptParsed = diff.kept
      .map((lit) => parsedByLiteral.get(lit))
      .filter((s): s is ParsedScope => s !== undefined);
    const addedParsed = diff.added
      .map((lit) => parsedByLiteral.get(lit))
      .filter((s): s is ParsedScope => s !== undefined);

    const keptSection =
      keptParsed.length > 0
        ? `<div class="section section--kept">
            <h2>Previously granted</h2>
            ${keptParsed.map((s) => scopeCheckbox(s)).join("\n")}
          </div>`
        : "";
    const addedSection =
      addedParsed.length > 0
        ? `<div class="section section--added">
            <h2>New permissions</h2>
            ${addedParsed.map((s) => scopeCheckbox(s)).join("\n")}
          </div>`
        : "";
    const removedSection =
      diff.removed.length > 0
        ? `<div class="section section--removed">
            <h2>No longer requested</h2>
            <p class="field__hint">These permissions were granted previously but the app isn't asking for them now. They'll be dropped when you approve.</p>
            ${diff.removed.map((lit) => removedRow(lit)).join("\n")}
          </div>`
        : "";
    scopesHtml = `${keptSection}${addedSection}${removedSection}`;
  } else {
    // First-time consent — OIDC identity / read / write sections.
    const oidcScopes = params.scopes.filter((s) => s.kind === "oidc");
    const readScopes = params.scopes.filter((s) => s.operation === "read");
    const writeScopes = params.scopes.filter((s) => s.operation === "write");

    const oidcSection =
      oidcScopes.length > 0
        ? `<div class="section">
            <h2>Identity</h2>
            ${oidcScopes.map((s) => scopeCheckbox(s)).join("\n")}
          </div>`
        : "";
    const readSection =
      readScopes.length > 0
        ? `<div class="section">
            <h2>Read access</h2>
            ${readScopes.map((s) => scopeCheckbox(s)).join("\n")}
          </div>`
        : "";
    const writeSection =
      writeScopes.length > 0
        ? `<div class="section">
            <h2>Read and write access</h2>
            ${writeScopes.map((s) => scopeCheckbox(s)).join("\n")}
          </div>`
        : "";
    scopesHtml = `${oidcSection}${readSection}${writeSection}`;
  }

  // Lede copy reflects whether we're showing a fresh consent or a
  // re-consent with changes.
  const leadeText = showDiff
    ? `<span class="client-name">${safeClient}</span> is requesting updated access to your data`
    : `<span class="client-name">${safeClient}</span> wants to access your data`;

  // T-131: form POSTs to the Myme decision handler at
  // /auth/authorize/decision (not directly to the plugin's
  // /auth/oauth2/consent) so the consent-side `system.connection`
  // projection + `auth.grant.created` audit row land deterministically.
  // The Myme handler then proxies to the plugin to complete the flow.
  // PKCE / state / redirect_uri are bound to the code server-side; the
  // form carries only the binding handle (`code`) + decision + client_id +
  // scope selection.
  const bodyHtml = `
    <h1>${leadeText}</h1>
    <form method="POST" action="/auth/authorize/decision">
      <input type="hidden" name="client_id" value="${safeClientId}">
      <input type="hidden" name="code" value="${safeCode}">

      ${scopesHtml}

      <div class="actions">
        <button type="submit" name="accept" value="true" class="btn btn--primary">Approve</button>
        <button type="submit" name="accept" value="false" class="btn">Deny</button>
      </div>
    </form>
  `;

  return renderAuthLayout({
    title: `Authorize ${params.clientName}`,
    bodyHtml,
    wide: true,
  });
}
