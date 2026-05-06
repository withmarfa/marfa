/**
 * Auth-page stylesheet, served from `GET /auth/static/auth.css`.
 *
 * Exported as a TypeScript template literal (rather than a sibling
 * `.css` file) so tsup bundles it into `dist/` without a separate
 * static-asset copy step. Treat the body as plain CSS — the editor
 * loses syntax highlighting inside the literal but the runtime
 * shape is bytewise identical to a real `auth.css`.
 *
 * Wave C PR4. Future PRs (PR5 polish, PR6 passkey button, PR7
 * security page) will edit this file in place.
 */

export const AUTH_CSS = `/*
 * Myme auth-page stylesheet.
 *
 * Wave C PR4 — single source of truth for CSS across every auth surface
 * (sign-in, sign-up, consent, device flow, and the email-verify /
 * forgot-password / reset-password pages added in PR2 + PR3). Loaded
 * once and cached at the edge; the page renderers reference classes
 * by name and never inline styles.
 *
 * Design tokens are CSS custom properties so a self-host operator can
 * theme the surface with a small override stylesheet without forking.
 *
 * Mobile-first: 16px body, 44px tap targets, single-column form on
 * small screens. The card lifts to a centred max-width:420px / 460px
 * panel from 480px up.
 */

:root {
  color-scheme: light;

  /* Surface tokens. */
  --bg: #fafaf8;
  --card: #ffffff;
  --ink: #1a1a1a;
  --ink-soft: #555;
  --ink-faint: #999;
  --border: #e2e2dc;

  /* Accent — the dark-ink primary used on every auth page since
     Wave A; keeps the surface visually consistent with the rest of
     the Myme product. */
  --accent: #1a1a1a;
  --accent-hover: #333;

  /* Status banners. */
  --error-bg: #fdecec;
  --error-border: #f5b8b8;
  --error-ink: #842424;
  --success-bg: #ecf6e9;
  --success-border: #b8d8af;
  --success-ink: #2a5a1f;

  /* Section background — used by consent + device-consent group blocks. */
  --section-bg: #f7f7f3;

  /* Scope literal pill — monospace badge inside consent rows. */
  --pill-bg: #eef0ea;
  --pill-ink: #4b5563;

  /* Scale tokens. */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --gap-xs: 4px;
  --gap-sm: 8px;
  --gap-md: 14px;
  --gap-lg: 20px;
  --gap-xl: 24px;
}

* {
  box-sizing: border-box;
}

body {
  /* 16px body to keep iOS Safari from auto-zooming form fields. */
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica,
    Arial, sans-serif;
  margin: 0;
  padding: 24px;
  background: var(--bg);
  color: var(--ink);
  min-height: 100vh;
  display: grid;
  place-items: center;
}

.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 32px;
  width: 100%;
  max-width: 460px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

/* Wider variant for surfaces that show longer scope lists / diff
   sections (consent, security page once it lands in PR7). */
.card--wide {
  max-width: 560px;
}

h1 {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 8px;
  letter-spacing: -0.01em;
}

/* \`.lede\` is the subtitle paragraph below the H1 — short, soft-ink. */
.lede {
  color: var(--ink-soft);
  margin: 0 0 var(--gap-xl);
  font-size: 14px;
  line-height: 1.45;
}

.banner {
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid;
  font-size: 13px;
  line-height: 1.4;
}
.banner--error {
  background: var(--error-bg);
  border-color: var(--error-border);
  color: var(--error-ink);
}
.banner--success {
  background: var(--success-bg);
  border-color: var(--success-border);
  color: var(--success-ink);
}

/* Tabbed mode-switcher (sign-in: password vs. magic link). */
.tabs {
  display: flex;
  gap: var(--gap-xs);
  margin: 0 0 var(--gap-lg);
  border-bottom: 1px solid var(--border);
}
.tab {
  padding: var(--gap-sm) 12px;
  color: var(--ink-soft);
  text-decoration: none;
  font-size: 13px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tab:hover {
  color: var(--ink);
}
.tab--active {
  color: var(--ink);
  border-bottom-color: var(--ink);
  font-weight: 500;
}

/* Generic form layout. */
.form {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field__label {
  font-size: 13px;
  color: var(--ink-soft);
  font-weight: 500;
}
.field__hint {
  font-size: 12px;
  color: var(--ink-faint);
  margin: 0;
}

input[type="email"],
input[type="password"],
input[type="text"] {
  font: inherit;
  /* 44px effective tap target (12 + 1.5em line + 12). */
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--ink);
  width: 100%;
  min-height: 44px;
}
input[type="email"]:focus,
input[type="password"]:focus,
input[type="text"]:focus {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
  border-color: var(--ink);
}

/* Monospace centred input for the device-flow user_code. */
.field__input--code {
  font: 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.1em;
  text-align: center;
  text-transform: uppercase;
}

.btn {
  font: inherit;
  /* 44px tap target. */
  min-height: 44px;
  padding: 10px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--ink);
  cursor: pointer;
  font-weight: 500;
  background: var(--card);
  color: var(--ink);
}
.btn:hover {
  background: var(--bg);
}
.btn:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.btn--primary {
  background: var(--accent);
  color: var(--card);
}
.btn--primary:hover {
  background: var(--accent-hover);
}

.btn--oidc {
  width: 100%;
}

.btn--danger {
  border-color: var(--ink-soft);
}

.separator {
  display: flex;
  align-items: center;
  text-align: center;
  margin: var(--gap-lg) 0 12px;
  color: var(--ink-faint);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.separator::before,
.separator::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}
.separator span {
  padding: 0 12px;
}

.oidc {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}
.oidc form {
  margin: 0;
}

.aux {
  margin: var(--gap-lg) 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--ink-soft);
}
.aux a {
  color: var(--ink);
}

/* Section block — used on consent and device-consent screens to group
   scopes (read / write / kept / added / removed in the PR5 diff
   variant). */
.section {
  margin: 16px 0;
  padding: 12px 14px;
  background: var(--section-bg);
  border-radius: var(--radius-md);
}
.section h2 {
  font-size: 12px;
  margin: 0 0 var(--gap-sm);
  color: var(--ink-soft);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
}

/* Bulleted scope list — one row per <scope>:<verb> entry, optional
   plain-English description on the second line. */
.scopes {
  margin: 0;
  padding: 0;
  list-style: none;
}
.scopes li {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 6px;
  font-size: 13px;
  background: var(--card);
}
.scopes li:last-child {
  margin-bottom: 0;
}
.scopes code {
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ink-faint);
  display: block;
  margin-top: 2px;
}

/* Consent-screen scope row — checkbox + literal pill + human description. */
.scope-row {
  display: block;
  margin: var(--gap-xs) 0;
}
.scope-literal {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--pill-ink);
  background: var(--pill-bg);
  padding: 1px 6px;
  border-radius: 4px;
}
.scope-human {
  display: block;
  margin-left: 24px;
  font-size: 13px;
  color: var(--ink);
  margin-top: 2px;
}

/* Action row at the bottom of consent / device-consent forms. */
.actions {
  display: flex;
  gap: 12px;
  margin-top: var(--gap-xl);
}
.actions form {
  flex: 1;
  margin: 0;
}
.actions button {
  width: 100%;
}

/* Used inside the .lede to highlight the requesting client name on
   consent + device-consent. */
.client-name {
  font-weight: 600;
  color: var(--ink);
}
`;
