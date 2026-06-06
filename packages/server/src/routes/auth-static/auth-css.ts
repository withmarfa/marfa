/**
 * Auth-page stylesheet, served from `GET /auth/static/auth.css`.
 *
 * Exported as a TypeScript template literal (rather than a sibling
 * `.css` file) so tsup bundles it into `dist/` without a separate
 * static-asset copy step. Treat the body as plain CSS — the editor
 * loses syntax highlighting inside the literal but the runtime
 * shape is bytewise identical to a real `auth.css`.
 *
 * Stylesheet for all auth surfaces. Design tokens, typography, and
 * consent-page primitives (section labels, toggle switches, hairline-
 * divided rows) live here. All auth shells share these styles — sign-in,
 * sign-up, verify-email, forgot-password, reset-password, device-flow,
 * and security pages.
 */

export const AUTH_CSS = `/*
 * Marfa auth-page stylesheet.
 *
 * Single source of truth for CSS across every auth surface (sign-in,
 * sign-up, consent, device flow, email-verify, forgot-password,
 * reset-password, security). Loaded once and cached at the edge; page
 * renderers reference classes by name and never inline styles.
 *
 * Design tokens are CSS custom properties so a self-host operator can
 * theme the surface with a small override stylesheet without forking.
 *
 * Mobile-first: 16px body, 44px tap targets, single-column form on
 * small screens. The card lifts to a centred max-width:460px / 560px
 * panel from 480px up.
 */

:root {
  color-scheme: light;

  /* Surface tokens. */
  --bg: #fafaf7;
  --card: #ffffff;
  --ink: #0f0f0f;
  --ink-soft: #5a5a55;
  --ink-faint: #9b9b96;
  --border: #ececea;
  --border-strong: #d9d9d4;
  --hairline: #f1f1ee;

  /* Accent — dark-ink primary used across all auth surfaces. */
  --accent: #0f0f0f;
  --accent-hover: #2a2a2a;

  /* Status banners. */
  --error-bg: #fdecec;
  --error-border: #f5b8b8;
  --error-ink: #842424;
  --success-bg: #ecf6e9;
  --success-border: #b8d8af;
  --success-ink: #2a5a1f;

  /* Section background — used by auth surfaces that group scopes in a
     tinted block (device-consent today). */
  --section-bg: #fafaf7;

  /* Scope literal pill — used by the security page only; the consent
     screen hides literals entirely. */
  --pill-bg: #f1f1ee;
  --pill-ink: #6a6a64;

  /* Diff variants — subtle tints rather than saturated colours. */
  --added-tint: #f0f6ee;
  --added-ink: #2a5a1f;
  --removed-tint: #f4f3f0;

  /* Scale tokens. */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --gap-xs: 4px;
  --gap-sm: 8px;
  --gap-md: 14px;
  --gap-lg: 20px;
  --gap-xl: 28px;
  --gap-xxl: 40px;

  /* Motion. */
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
}

* {
  box-sizing: border-box;
}

body {
  /* 14px body for a denser, more elegant feel. Form inputs bump back
     to 16px so iOS Safari doesn't auto-zoom them. */
  font:
    14px/1.55 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Helvetica,
    Arial,
    sans-serif;
  margin: 0;
  padding: 32px 20px;
  background: var(--bg);
  color: var(--ink);
  min-height: 100vh;
  display: grid;
  place-items: center;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 32px;
  width: 100%;
  max-width: 420px;
  box-shadow:
    0 1px 2px rgba(15, 15, 15, 0.03),
    0 12px 36px rgba(15, 15, 15, 0.05);
}

/* Wider variant for surfaces that show longer scope lists / diff
   sections (consent, security page). */
.card--wide {
  max-width: 480px;
}

@media (max-width: 520px) {
  .card {
    padding: 24px 18px;
    border-radius: var(--radius-md);
  }
}

h1 {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 8px;
  letter-spacing: -0.015em;
  line-height: 1.25;
}

/* \`.lede\` is the subtitle paragraph below the H1 — short, soft-ink. */
.lede {
  color: var(--ink-soft);
  margin: 0 0 var(--gap-xl);
  font-size: 13px;
  line-height: 1.5;
}

.banner,
.alert {
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid;
  font-size: 13px;
  line-height: 1.45;
}
.banner--error,
.alert--error {
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
  /* 16px on the input itself so iOS Safari doesn't auto-zoom on focus
     (independent of the 14px body). Compact 8/10px padding keeps the
     field elegant — roughly 36px tall. */
  font:
    16px/1.4 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Helvetica,
    Arial,
    sans-serif;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--ink);
  width: 100%;
  transition:
    border-color 120ms var(--ease),
    box-shadow 120ms var(--ease);
}
input[type="email"]:focus,
input[type="password"]:focus,
input[type="text"]:focus {
  outline: none;
  border-color: var(--ink);
  box-shadow: 0 0 0 3px rgba(15, 15, 15, 0.08);
}

/* Monospace centred input for the device-flow user_code. */
.field__input--code {
  font:
    18px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  letter-spacing: 0.1em;
  text-align: center;
  text-transform: uppercase;
}

.btn {
  font: inherit;
  /* ~32px tall — elegant, not chunky. */
  min-height: 32px;
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  background: var(--card);
  color: var(--ink);
  white-space: nowrap;
  transition:
    background 120ms var(--ease),
    border-color 120ms var(--ease),
    transform 80ms var(--ease);
}
.btn:hover {
  background: var(--bg);
}
.btn:active {
  transform: translateY(0.5px);
}
.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(15, 15, 15, 0.18);
}
.btn:disabled,
.btn[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn--primary {
  background: var(--accent);
  color: var(--card);
  border-color: var(--accent);
}
.btn--primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

/* Larger-button size modifier — available for any callsite that asks
   for a bigger button. The consent + sign-in screens don't use it. */
.btn--lg {
  min-height: 40px;
  padding: 10px 18px;
  font-size: 14px;
}

.btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--ink-soft);
}
.btn--ghost:hover {
  background: var(--hairline);
  color: var(--ink);
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

/* ---------------------------------------------------------------- */
/* Consent screen                                                   */
/* ---------------------------------------------------------------- */

.consent-header {
  margin: 0 0 var(--gap-lg);
}
.consent-title {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 8px;
  letter-spacing: -0.015em;
  line-height: 1.25;
}
.consent-lede {
  margin: 0;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.5;
}
.consent-lede .client-name {
  color: var(--ink);
  font-weight: 600;
}

.consent-form {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.consent-footnote {
  margin: 18px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--ink-faint);
}

/* Section block — collapsible disclosure via native <details>. The
   summary is a single row (label, count, chevron) that flips to reveal
   per-scope toggles. No box, no border — just a hairline-divided list
   inside when open. */
.section {
  margin: 0;
  padding: 0;
  background: transparent;
  border: 0;
  border-top: 1px solid var(--hairline);
}
.section:first-of-type {
  border-top: 0;
}

/* Strip the native marker so the custom chevron is the only one. */
details.section > summary {
  list-style: none;
}
details.section > summary::-webkit-details-marker {
  display: none;
}

.section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: 12px 0;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.section__head:hover .section__label {
  color: var(--accent-hover);
}
.section__head--static {
  cursor: default;
}
.section__head--static:hover .section__label {
  color: var(--ink);
}

.section__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  margin: 0;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.section__count {
  font-size: 12px;
  color: var(--ink-faint);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  margin-left: auto;
  margin-right: 6px;
}
.section__chevron {
  width: 8px;
  height: 8px;
  border-right: 1.5px solid var(--ink-faint);
  border-bottom: 1.5px solid var(--ink-faint);
  transform: rotate(-45deg);
  transition: transform 160ms var(--ease);
  flex-shrink: 0;
  margin-right: 2px;
}
details.section[open] > summary .section__chevron {
  transform: rotate(45deg);
}
.section__head--static .section__chevron {
  display: none;
}

.section__hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--ink-soft);
  line-height: 1.5;
}

/* Diff variants — colour the section label rather than tinting the
   background; keeps the monochrome direction. */
.section--added .section__label {
  color: var(--added-ink);
}
.section--removed .section__label {
  color: var(--ink-soft);
}

.scope-list {
  display: flex;
  flex-direction: column;
  padding-bottom: 8px;
}

/* A single scope row — text on the left, toggle on the right. The
   whole row is a label so the user can click anywhere to toggle. */
.scope-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: 8px 0;
  cursor: pointer;
}
.scope-row__text {
  font-size: 13px;
  color: var(--ink);
  line-height: 1.45;
  flex: 1;
  min-width: 0;
}

.scope-row--removed {
  cursor: default;
}
.scope-row--removed .scope-row__text {
  color: var(--ink-faint);
  text-decoration: line-through;
}

/* iOS-style toggle switch. The native checkbox is visually hidden but
   keyboard-focusable; the track + thumb are pure CSS. Compact
   28×16 sizing — discreet, not chunky. */
.toggle {
  position: relative;
  display: inline-block;
  width: 28px;
  height: 16px;
  flex-shrink: 0;
}
.toggle input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
.toggle__track {
  position: absolute;
  inset: 0;
  background: var(--border-strong);
  border-radius: 16px;
  transition: background 160ms var(--ease);
  pointer-events: none;
}
.toggle__track::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: #ffffff;
  border-radius: 50%;
  transition: transform 180ms var(--ease);
  box-shadow:
    0 1px 2px rgba(15, 15, 15, 0.18),
    0 0 0 0.5px rgba(15, 15, 15, 0.04);
}
.toggle input:checked + .toggle__track {
  background: var(--ink);
}
.toggle input:checked + .toggle__track::before {
  transform: translateX(12px);
}
.toggle input:focus-visible + .toggle__track {
  box-shadow: 0 0 0 3px rgba(15, 15, 15, 0.18);
}
.toggle input:disabled + .toggle__track {
  opacity: 0.5;
  cursor: not-allowed;
}

/* .scopes list — the bullet-list shape used by some surfaces
   (device-consent on some pages). */
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
  font:
    12px/1.4 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  color: var(--ink-faint);
  display: block;
  margin-top: 2px;
}

/* .scope-literal / .scope-human aliases — the security-page rows and
   any renderer that targets these classes pick up the same styling
   tokens. */
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

/* Action row at the bottom of consent / device-consent forms.
   Side-by-side: Deny left (secondary), Allow right (primary, takes the
   weight of the row at 2× width). */
.actions {
  display: flex;
  gap: 8px;
  margin-top: var(--gap-lg);
}
.actions form {
  flex: 1;
  margin: 0;
}
.actions button {
  width: 100%;
}
.actions .btn--primary {
  flex: 2;
}
.actions--stacked {
  flex-direction: column;
  gap: var(--gap-sm);
}
.actions--stacked .btn--primary {
  flex: initial;
}

/* Used inside the .lede / consent-lede to highlight the requesting
   client name on consent + device-consent. */
.client-name {
  font-weight: 600;
  color: var(--ink);
}

/* Security page row layout. Used inside .section blocks for
   connected-apps + active-sessions lists. */
.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: var(--gap-sm) 0;
  border-top: 1px solid var(--border);
}
.row:first-of-type {
  border-top: 0;
  padding-top: 0;
}
.row__main {
  flex: 1;
  min-width: 0;
}
.row__title {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
  margin: 0 0 4px;
  word-break: break-word;
}
.row__meta {
  font-size: 12px;
  color: var(--ink-soft);
  margin: 2px 0 0;
  word-break: break-word;
}
.row__meta .scope-literal {
  margin-right: var(--gap-xs);
}
.row__action {
  flex-shrink: 0;
  margin: 0;
}

/* Inline tag for "current device" annotation on the active-session
   list; subtle, not a full banner. */
.tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--pill-bg);
  color: var(--pill-ink);
  margin-left: 6px;
  vertical-align: middle;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.tag--current {
  background: var(--success-bg);
  color: var(--success-ink);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
  }
}
`;
