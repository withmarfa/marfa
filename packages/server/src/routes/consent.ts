/**
 * OAuth consent screen renderer.
 *
 * Layout: the shared `/auth/static/auth.css` design tokens style the
 * screen, unifying the visual surface with sign-in / sign-up /
 * device-flow.
 *
 * Re-consent diff (T-032): when the caller passes `priorScopes` (the
 * scope set the user previously approved on this client, looked up via
 * `system.connection` of `kind: app`), the screen renders three group
 * blocks — Previously granted (kept), New permissions (added), and No
 * longer requested (removed) — instead of the flat read / write split.
 * First-time consent (no prior grant) renders the flat shape.
 *
 * Authorization flow (T-131): the @better-auth/oauth-provider plugin
 * signs the full authorize-request query string (response_type +
 * client_id + redirect_uri + scope + state + code_challenge +
 * code_challenge_method + exp + sig) and redirects to the consent page
 * carrying that signed blob. The consent form POSTs back to
 * `/auth/oauth2/consent` with `{ accept, scope?, oauth_query }` — the
 * plugin verifies the sig, re-hydrates the original params from
 * `oauth_query`, mints the code, and redirects to the RP's
 * `redirect_uri?code=...`.
 *
 * So: the form carries the entire signed query string as a single
 * hidden field `oauth_query`. `client_id` is rendered for the projection
 * handler's use (it reads the form's `client_id` directly to write the
 * `system.connection { kind: "app" }` row + audit emit).
 *
 * Polish pass: visual rework toward a calm, restrained surface (Luma /
 * Amie / Linear reference). No avatar, no eyebrow, no boxed sections,
 * no monospace scope literals — just confident typography, sections as
 * bold labels with quiet counts, and one toggle per scope. Default is
 * everything on; the primary "Allow access" button is the obvious move.
 * The hard form contract (action, hidden inputs, scope `name`/`value`,
 * accept button names) is preserved verbatim — the toggles are
 * visually-styled checkboxes so submission shape doesn't change.
 */

import type { ParsedScope } from "@withmarfa/shared";
import { renderAuthLayout } from "./auth-layout.js";
import { computeConsentDiff } from "./consent-diff.js";

interface ConsentParams {
  clientName: string;
  scopes: ParsedScope[];
  clientId: string;
  /**
   * The full signed query string forwarded by the plugin's authorize
   * endpoint (response_type, client_id, redirect_uri, scope, state,
   * code_challenge, code_challenge_method, exp, sig — everything).
   * Threaded into a hidden field and POSTed back to
   * `/auth/oauth2/consent` so the plugin can verify the signature and
   * re-hydrate the original request parameters.
   */
  oauthQuery: string;
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
  /**
   * T-131 fix-up F2: when set, renders an inline error banner above
   * the form. Used when the page is reached via a redirect from a
   * failed consent submission (e.g. zero-scopes accept → "approve
   * needs at least one permission ticked"). When undefined, no banner
   * renders.
   */
  errorMessage?: string;
}

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

interface SectionDescriptor {
  /** Visible section heading. */
  label: string;
  /** Optional short hint shown under the heading. */
  hint?: string;
  /** Modifier CSS class (added / removed variants in the diff path). */
  modifier?: "kept" | "added" | "removed";
  scopes: ParsedScope[];
}

/** Renders the OAuth consent screen as an HTML string. */
export function renderConsentScreen(params: ConsentParams): string {
  const descriptionFor = (typePattern: string): string | undefined =>
    params.descriptions?.[typePattern];

  /** A single grant-this-permission row — toggle on the right. */
  const scopeRow = (scope: ParsedScope, opts?: { checked?: boolean }) => {
    const literal = scopeLiteralFor(scope);
    const description = descriptionFor(scope.typePattern);
    // Fall back to the literal only if there's no plain-English line
    // for this scope — that should be rare (every core type + OIDC
    // scope has a description). The literal is otherwise hidden.
    const human = description ?? literal;
    const checked = opts?.checked === false ? "" : "checked";
    return `<label class="scope-row">
      <span class="scope-row__text">${escapeHtml(human)}</span>
      <span class="toggle">
        <input type="checkbox" name="scopes" value="${escapeHtml(literal)}" ${checked}>
        <span class="toggle__track" aria-hidden="true"></span>
      </span>
    </label>`;
  };

  /** Static row used for "No longer requested" entries in the diff variant. */
  const removedRow = (literal: string): string => {
    const lastColon = literal.lastIndexOf(":");
    const typePattern = lastColon > 0 ? literal.slice(0, lastColon) : literal;
    const description = descriptionFor(typePattern);
    const human = description ?? literal;
    return `<div class="scope-row scope-row--removed">
      <span class="scope-row__text">${escapeHtml(human)}</span>
    </div>`;
  };

  const renderSection = (descriptor: SectionDescriptor): string => {
    if (descriptor.scopes.length === 0) return "";

    const modifierClass = descriptor.modifier
      ? ` section--${descriptor.modifier}`
      : "";

    const hintHtml = descriptor.hint
      ? `<p class="section__hint">${escapeHtml(descriptor.hint)}</p>`
      : "";

    const total = descriptor.scopes.length;

    // Removed-section variant: read-only list, no toggles, no
    // disclosure (it's informational so should always be visible).
    if (descriptor.modifier === "removed") {
      const literals = descriptor.scopes.map((s) => scopeLiteralFor(s));
      return `<section class="section${modifierClass}">
        <header class="section__head section__head--static">
          <span class="section__label">${escapeHtml(descriptor.label)}</span>
          <span class="section__count">${String(total)}</span>
        </header>
        ${hintHtml}
        <div class="scope-list">${literals.map(removedRow).join("")}</div>
      </section>`;
    }

    // All other sections collapse by default. Summary shows label +
    // live "X enabled" / "X of Y enabled" count + chevron. Defaults
    // are everything-on, so the initial state always reads "Y enabled"
    // with no "of" — clean.
    const countLabel = `${String(total)} enabled`;
    return `<details class="section${modifierClass}" data-section>
      <summary class="section__head">
        <span class="section__label">${escapeHtml(descriptor.label)}</span>
        <span class="section__count" data-section-count data-section-total="${String(total)}">${countLabel}</span>
        <span class="section__chevron" aria-hidden="true"></span>
      </summary>
      ${hintHtml}
      <div class="scope-list">
        ${descriptor.scopes.map((s) => scopeRow(s)).join("")}
      </div>
    </details>`;
  };

  const safeClient = escapeHtml(params.clientName);
  const safeClientId = escapeHtml(params.clientId);
  const safeOauthQuery = escapeHtml(params.oauthQuery);
  const showDiff = params.priorScopes !== undefined;

  const sections: SectionDescriptor[] = [];

  if (showDiff) {
    const nextLiterals = params.scopes.map(scopeLiteralFor);
    const diff = computeConsentDiff(params.priorScopes ?? [], nextLiterals);
    const parsedByLiteral = new Map<string, ParsedScope>();
    for (const scope of params.scopes) {
      parsedByLiteral.set(scopeLiteralFor(scope), scope);
    }
    const lookup = (lits: readonly string[]): ParsedScope[] =>
      lits
        .map((lit) => parsedByLiteral.get(lit))
        .filter((s): s is ParsedScope => s !== undefined);

    // Order: the change first ("New permissions"), then the carry-over,
    // then the informational drop-list at the bottom.
    sections.push({
      label: "New permissions",
      hint: "These were not part of the previous grant.",
      modifier: "added",
      scopes: lookup(diff.added),
    });
    sections.push({
      label: "Previously granted",
      modifier: "kept",
      scopes: lookup(diff.kept),
    });

    // Removed section uses literals only — wrap in dummy ParsedScopes
    // so the descriptor + render loop stay uniform.
    const removedAsParsed: ParsedScope[] = diff.removed.map((literal) => {
      const lastColon = literal.lastIndexOf(":");
      const typePattern = lastColon > 0 ? literal.slice(0, lastColon) : literal;
      const operationPart = lastColon > 0 ? literal.slice(lastColon + 1) : "";
      const operation: ParsedScope["operation"] =
        operationPart === "write" ? "write" : "read";
      return {
        typePattern,
        operation,
      } as ParsedScope;
    });
    sections.push({
      label: "No longer requested",
      hint: "These were granted before but the app is not asking for them now. They will be dropped.",
      modifier: "removed",
      scopes: removedAsParsed,
    });
  } else {
    const oidcScopes = params.scopes.filter((s) => s.kind === "oidc");
    const readScopes = params.scopes.filter((s) => s.operation === "read");
    const writeScopes = params.scopes.filter((s) => s.operation === "write");

    sections.push({
      label: "Identity",
      scopes: oidcScopes,
    });
    sections.push({
      label: "Read",
      scopes: readScopes,
    });
    sections.push({
      label: "Read & write",
      scopes: writeScopes,
    });
  }

  const sectionsHtml = sections.map(renderSection).join("");

  const titleText = showDiff ? "Update access" : "Allow access";
  const ledeText = showDiff
    ? `<span class="client-name">${safeClient}</span> needs different permissions than before.`
    : `<span class="client-name">${safeClient}</span> is asking to access your Marfa space. Untick anything you'd rather not share.`;

  // T-131 F2 inline error banner — survives across pages because the
  // POST handler 302s back to GET with `?error=...` on validation
  // failure rather than re-rendering.
  const errorBanner = params.errorMessage
    ? `<div class="alert alert--error" role="alert">${escapeHtml(params.errorMessage)}</div>`
    : "";

  // Live "X enabled" / "X of Y enabled" count on each section summary.
  // Without JS the count still renders correctly at the initial state
  // (everything-on → "Y enabled"); the script just keeps it accurate
  // when the user toggles individual scopes. Also stops propagation on
  // toggle clicks so flicking a switch inside the summary doesn't also
  // collapse the section.
  const enhancementScript = `
    (function () {
      var sections = document.querySelectorAll('[data-section]');
      sections.forEach(function (section) {
        var checkboxes = section.querySelectorAll('input[type="checkbox"][name="scopes"]');
        var countEl = section.querySelector('[data-section-count]');
        if (!countEl || checkboxes.length === 0) return;
        var total = checkboxes.length;
        function update() {
          var checked = 0;
          checkboxes.forEach(function (c) { if (c.checked) checked++; });
          countEl.textContent = checked === total
            ? total + ' enabled'
            : checked + ' of ' + total + ' enabled';
        }
        checkboxes.forEach(function (c) { c.addEventListener('change', update); });
        update();
        section.querySelectorAll('.scope-row').forEach(function (row) {
          row.addEventListener('click', function (e) { e.stopPropagation(); });
        });
      });
    })();
  `
    .trim()
    .replace(/\s+/g, " ");

  const bodyHtml = `
    <header class="consent-header">
      <h1 class="consent-title">${escapeHtml(titleText)}</h1>
      <p class="consent-lede">${ledeText}</p>
    </header>
    ${errorBanner}
    <form method="POST" action="/auth/authorize/decision" class="consent-form" novalidate>
      <input type="hidden" name="client_id" value="${safeClientId}">
      <input type="hidden" name="oauth_query" value="${safeOauthQuery}">

      ${sectionsHtml}

      <div class="actions">
        <button type="submit" name="accept" value="false" class="btn">Deny</button>
        <button type="submit" name="accept" value="true" class="btn btn--primary">Allow access</button>
      </div>

      <p class="consent-footnote">You can revoke this anytime from Security settings.</p>
    </form>
    <script>${enhancementScript}</script>
  `;

  return renderAuthLayout({
    title: showDiff
      ? `Update access — ${params.clientName}`
      : `Authorize ${params.clientName}`,
    bodyHtml,
    wide: true,
  });
}
