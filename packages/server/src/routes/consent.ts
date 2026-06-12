/**
 * OAuth consent screen renderer.
 *
 * Layout: the shared `/auth/static/auth.css` design tokens style the
 * screen, unifying the visual surface with sign-in / sign-up /
 * device-flow.
 *
 * Re-consent diff: when the caller passes `priorScopes` (the scope set
 * the user previously approved on this client, looked up via
 * `system.connection` of `kind: app`), the screen renders three group
 * blocks — Previously granted (kept), New permissions (added), and No
 * longer requested (removed) — instead of the flat read / write split.
 * First-time consent (no prior grant) renders the flat shape.
 *
 * Authorization flow: the @better-auth/oauth-provider plugin
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

import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import { renderAuthLayout } from "./auth-layout.js";
import { computeConsentDiff } from "./consent-diff.js";

interface ConsentParams {
  clientName: string;
  /**
   * When `true`, the client has no verified identity — a public client
   * (PKCE, `token_endpoint_auth_method: none`), which is exactly what every
   * unauthenticated Dynamic Client Registration (DCR) client is. The screen
   * renders an "Unverified app" indicator next to the self-asserted client
   * name so a user can tell it apart from a confidential, vetted client. A
   * scammer can register a DCR client named "Google Drive"; the name alone
   * is not trustworthy, and this badge says so. Defaults to `false` (no
   * badge) when omitted.
   */
  unverified?: boolean;
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
   * The literal scope set the user previously approved on this client
   * (e.g. `["core.note:read", "core.note:write"]`). When present, the
   * screen renders the diff variant — "Previously granted" / "New
   * permissions" / "No longer requested" — instead of the flat read /
   * write split. When absent (first-time consent or no prior grant),
   * renders flat.
   */
  priorScopes?: readonly string[];
  /**
   * The configured permission bundles. When present (and not a re-consent
   * diff), the screen renders the per-bundle expand view: each bundle is its
   * own collapsible row carrying a master toggle, and expanding the row
   * reveals that bundle's granular scopes. When absent, the screen falls
   * back to the flat Identity / Read / Read-&-write grouping. The form
   * contract is identical either way — the submitted `scopes` checkboxes
   * carry literal values.
   */
  bundles?: PermissionBundle[];
  /**
   * When set, renders an inline error banner above the form. Used when
   * the page is reached via a redirect from a failed consent submission
   * (e.g. zero-scopes accept → "approve needs at least one permission
   * ticked"). When undefined, no banner renders.
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

  /** A single grant-this-permission row for the flat / re-consent-diff view
   *  — plain-English label on the left, toggle switch on the right. Checked
   *  by default (the requested scope is granted unless the user unticks it). */
  const scopeRow = (scope: ParsedScope): string => {
    const literal = scopeLiteralFor(scope);
    const description = descriptionFor(scope.typePattern);
    const human = description ?? literal; // literal fallback is rare; every core/OIDC scope has a description
    return `<label class="scope-row">
      <span class="scope-row__text">${escapeHtml(human)}</span>
      <span class="toggle">
        <input type="checkbox" name="scopes" value="${escapeHtml(literal)}" checked>
        <span class="toggle__track" aria-hidden="true"></span>
      </span>
    </label>`;
  };

  /** A granular scope sub-item inside an expanded bundle: a quiet label on
   *  the left and a small squared check on the right. The checkbox is the
   *  real `name="scopes"` submitter (checked by default), so the no-JS
   *  fallback still grants every scope; `data-bundle-member` lets the
   *  bundle's master toggle drive it, and member edits reflect back onto
   *  the master. */
  const bundleSubRow = (scope: ParsedScope, bundleId: string): string => {
    const literal = scopeLiteralFor(scope);
    const description = descriptionFor(scope.typePattern);
    const human = description ?? literal; // literal fallback is rare; every core/OIDC scope has a description
    return `<label class="bundle-sub">
      <span class="bundle-sub__label">${escapeHtml(human)}</span>
      <input class="chk" type="checkbox" name="scopes" value="${escapeHtml(literal)}" data-bundle-member="${escapeHtml(bundleId)}" checked>
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
  const showBundles =
    !showDiff && Array.isArray(params.bundles) && params.bundles.length > 0;

  /** Per-bundle expand view: each bundle is its own collapsible `<details>`
   *  row. The summary carries the bundle label, a chevron, and the bundle's
   *  master toggle (on by default); expanding the row reveals that bundle's
   *  granular scope sub-items. The granular `name="scopes"` checkboxes are
   *  the real submitters (checked), so the no-JS fallback grants the full
   *  default set — native `<details>` expands without JS, and JS only adds
   *  the master-toggle ↔ member linkage. The decision handler's contract is
   *  unchanged — it reads `scopes`. */
  const renderBundles = (): string => {
    const assigned = new Set<string>();
    const groups = (params.bundles ?? [])
      .map((bundle) => {
        const inBundle = new Set(bundle.scopes);
        const members = params.scopes.filter((s) => {
          const lit = scopeLiteralFor(s);
          if (assigned.has(lit) || !inBundle.has(lit)) return false;
          assigned.add(lit);
          return true;
        });
        return { bundle, members };
      })
      .filter((g) => g.members.length > 0);

    const residual = params.scopes.filter(
      (s) => !assigned.has(scopeLiteralFor(s)),
    );

    const bundleBlocks = groups
      .map(({ bundle, members }, i) => {
        const granular = members
          .map((s) => bundleSubRow(s, bundle.id))
          .join("");
        // First bundle is expanded by default so the surface reads as
        // explorable at a glance; the rest start collapsed.
        const openAttr = i === 0 ? " open" : "";
        // The master toggle has NO `name` — it never submits. It's a
        // JS-only driver for the member checkboxes (which do submit).
        // `event.preventDefault()` on the toggle label stops a click on
        // the switch from also toggling the parent <details>; the input's
        // own state is then flipped by the enhancement script. Without JS
        // the switch is inert, but every member checkbox is real + checked,
        // so the default grant still submits in full.
        return `<details class="bundle-expand"${openAttr}>
          <summary>
            <span class="bundle-row__text">
              <span class="bundle-row__label">${escapeHtml(bundle.label)} <span class="bundle-expand__chevron" aria-hidden="true"></span></span>
              <span class="bundle-row__desc">${escapeHtml(bundle.description)}</span>
            </span>
            <label class="toggle" data-bundle-master="${escapeHtml(bundle.id)}" onclick="event.preventDefault()">
              <input type="checkbox" data-bundle-toggle="${escapeHtml(bundle.id)}" checked aria-label="${escapeHtml(bundle.label)}">
              <span class="toggle__track" aria-hidden="true"></span>
            </label>
          </summary>
          <div class="bundle-expand__sub">${granular}</div>
        </details>`;
      })
      .join("");

    // Requested scopes that belong to no bundle (e.g. offline_access, or an
    // edge scope outside the default bundle set). Granted by default and kept
    // out of the expand rows, but rendered as a visible "Other" group of
    // scope rows so the user still sees each one's plain-English description
    // and can untick it. The checkboxes are real + checked, so they submit.
    const residualBlock =
      residual.length > 0
        ? `<div class="bundle--residual">
            <p class="bundle-residual__head">Other</p>
            ${residual.map((s) => scopeRow(s)).join("")}
          </div>`
        : "";

    return `<div class="bundles">${bundleBlocks}${residualBlock}</div>`;
  };

  let contentHtml: string;
  if (showBundles) {
    contentHtml = renderBundles();
  } else {
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

      // Wrap removed literals in ParsedScope objects so the render loop stays uniform.
      const removedAsParsed: ParsedScope[] = diff.removed.map((literal) => {
        const lastColon = literal.lastIndexOf(":");
        const typePattern =
          lastColon > 0 ? literal.slice(0, lastColon) : literal;
        const operationPart = lastColon > 0 ? literal.slice(lastColon + 1) : "";
        const operation: ParsedScope["operation"] =
          operationPart === "write" ? "write" : "read";
        return {
          typePattern,
          operation,
        };
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

    contentHtml = sections.map(renderSection).join("");
  }

  // Unverified-app indicator. A public / DCR client self-asserts its name
  // with no vetted identity behind it, so render a clear badge next to the
  // name plus an explicit caution line. The badge sits inline with the
  // client-name span; the caution line is its own block above the form so
  // it can't be missed.
  const unverifiedBadge = params.unverified
    ? ` <span class="unverified-badge" title="This app self-reported its name. Marfa has not verified who it is.">Unverified app</span>`
    : "";
  const unverifiedNotice = params.unverified
    ? `<div class="alert alert--warn" role="alert">
        <strong>This app is unverified.</strong> The name above was set by the app itself — Marfa has not confirmed who built it. Only continue if you trust this app, and check the permissions below carefully.
      </div>`
    : "";

  const clientNameHtml = `<span class="client-name">${safeClient}</span>${unverifiedBadge}`;

  const titleText = showDiff ? "Update access" : "Allow access";
  const ledeText = showDiff
    ? `${clientNameHtml} needs different permissions than before.`
    : `${clientNameHtml} is asking to access your Marfa space. Untick anything you'd rather not share.`;

  const errorBanner = params.errorMessage
    ? `<div class="alert alert--error" role="alert">${escapeHtml(params.errorMessage)}</div>`
    : "";

  // Progressive-enhancement script. Two jobs: (1) flat/diff view — keep the
  // "X enabled" count accurate as toggles flip; (2) bundle view — each bundle
  // master toggle drives its member checkboxes (the ones that actually
  // submit), and member edits reflect back onto the master. The master toggle
  // lives inside a <summary> and its label cancels the native click
  // (event.preventDefault()) so a switch click never spuriously toggles the
  // <details>; the script therefore flips the master input's state itself on
  // click. With no JS the <details> still expands
  // natively and every member checkbox is real + checked, so the form is
  // fully usable and submits the full default set. NOTE: the template is
  // minified with `replace(/\\s+/g, " ")`, which collapses newlines — so it
  // MUST NOT contain `//` line comments (they would swallow the rest).
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

      document.querySelectorAll('[data-bundle-master]').forEach(function (masterLabel) {
        var id = masterLabel.getAttribute('data-bundle-master');
        var master = masterLabel.querySelector('input[data-bundle-toggle="' + id + '"]');
        var members = document.querySelectorAll('input[data-bundle-member="' + id + '"]');
        if (!master) return;
        function syncMaster() {
          var any = false, all = true;
          members.forEach(function (x) { if (x.checked) any = true; else all = false; });
          master.checked = any;
          master.indeterminate = any && !all;
        }
        masterLabel.addEventListener('click', function () {
          master.checked = !master.checked;
          master.indeterminate = false;
          members.forEach(function (m) { m.checked = master.checked; });
        });
        members.forEach(function (m) {
          m.addEventListener('change', syncMaster);
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
    ${unverifiedNotice}
    ${errorBanner}
    <form method="POST" action="/auth/authorize/decision" class="consent-form" novalidate>
      <input type="hidden" name="client_id" value="${safeClientId}">
      <input type="hidden" name="oauth_query" value="${safeOauthQuery}">

      ${contentHtml}

      <div class="actions actions--stacked">
        <button type="submit" name="accept" value="true" class="btn btn--primary">Allow access</button>
        <button type="submit" name="accept" value="false" class="btn btn--ghost">Deny</button>
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
