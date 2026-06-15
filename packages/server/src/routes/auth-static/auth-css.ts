/**
 * Auth-surface stylesheet, served from `GET /auth/static/auth.css`.
 *
 * Exported as a TypeScript template literal (rather than a sibling `.css`
 * file) so tsup bundles it into `dist/` without a separate static-asset
 * copy step. Treat the body as plain CSS.
 *
 * Single source of truth for every `/auth/*` page (sign-in, sign-up,
 * verify-email, forgot/reset password, OAuth consent, device flow, the
 * API-keys console, the security page, passkey enrollment). Page renderers
 * reference these classes by name and never inline styles.
 *
 * The design is a calm, monochrome "Luma" shadcn surface: a white card on
 * a soft gray canvas, soft-filled pill inputs, near-black primary buttons,
 * a quiet ghost secondary. Colors are the shadcn "neutral" ramp. Tokens
 * are CSS custom properties so a self-host operator can re-theme without
 * forking, and dark mode follows the device by flipping the same tokens.
 */

export const AUTH_CSS = `/* Marfa auth surface — Luma stylesheet. */

:root {
  color-scheme: light dark;

  /* Neutral ramp. */
  --bg: #f5f5f5;
  --card: #ffffff;
  --fg: #0a0a0a;
  --fg-muted: #737373;
  --fg-faint: #a3a3a3;
  --border: #e5e5e5;
  --border-strong: #d4d4d4;
  --hairline: #ededed;
  --field: #f5f5f5;
  --field-hover: #ececec;
  --surface-2: #f5f5f5;

  /* Primary (near-black). */
  --primary: #171717;
  --primary-hover: #2a2a2a;
  --primary-fg: #fafafa;

  /* Focus ring. */
  --ring: rgba(10, 10, 10, 0.13);

  /* Destructive (danger actions). */
  --destructive: #dc2626;
  --destructive-hover: #b91c1c;
  --destructive-fg: #ffffff;
  --destructive-soft-border: #f3c5bf;

  /* Status — tasteful tints. */
  --success-bg: #f0fdf4;
  --success-border: #bbf7d0;
  --success-fg: #166534;
  --error-bg: #fef2f2;
  --error-border: #fecaca;
  --error-fg: #991b1b;
  --warn-bg: #fffbeb;
  --warn-border: #fde68a;
  --warn-fg: #92400e;

  /* Radii — everything rounded (Luma). */
  --r-pill: 999px;
  --r-card: 26px;
  --r-lg: 18px;
  --r-md: 14px;
  --r-sm: 10px;

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
    --field: #232323;
    --field-hover: #2b2b2b;
    --surface-2: #1f1f1f;

    --primary: #fafafa;
    --primary-hover: #e5e5e5;
    --primary-fg: #171717;

    --ring: rgba(250, 250, 250, 0.2);

    --destructive: #f87171;
    --destructive-hover: #ef4444;
    --destructive-fg: #1a0a0a;
    --destructive-soft-border: #4d2424;

    --success-bg: #0e1f14;
    --success-border: #1f3d28;
    --success-fg: #86efac;
    --error-bg: #1f1212;
    --error-border: #3d1f1f;
    --error-fg: #fca5a5;
    --warn-bg: #1f1a0e;
    --warn-border: #3d3320;
    --warn-fg: #fcd34d;

    --shadow: none;
  }
  .card {
    box-shadow: none;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  padding: 40px 20px;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--fg);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ---------------------------------------------------------------- */
/* Card + typography                                                */
/* ---------------------------------------------------------------- */

.card {
  width: 100%;
  max-width: 400px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  padding: 24px;
  box-shadow: var(--shadow);
}
.card--wide {
  max-width: 460px;
}
.card--lg {
  max-width: 520px;
}
@media (max-width: 460px) {
  body {
    padding: 16px;
  }
  .card {
    padding: 22px;
    border-radius: 20px;
  }
}

h1 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.3;
}
h2 {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}
.lede {
  margin: 0 0 22px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--fg-muted);
}
.lede strong {
  color: var(--fg);
  font-weight: 600;
}
.lede + .lede {
  margin-top: -16px;
}
a {
  color: var(--fg);
  text-underline-offset: 2px;
}

/* ---------------------------------------------------------------- */
/* Forms + inputs                                                   */
/* ---------------------------------------------------------------- */

.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
}
.field__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-faint);
}

input[type="email"],
input[type="password"],
input[type="text"] {
  width: 100%;
  /* 16px so iOS Safari doesn't auto-zoom on focus. */
  font-family: inherit;
  font-size: 16px;
  line-height: 1.4;
  padding: 11px 16px;
  color: var(--fg);
  background: var(--field);
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  transition:
    background 0.12s var(--ease),
    border-color 0.12s var(--ease),
    box-shadow 0.12s var(--ease);
}
input::placeholder {
  color: var(--fg-faint);
}
input[type="email"]:hover,
input[type="password"]:hover,
input[type="text"]:hover {
  background: var(--field-hover);
}
input[type="email"]:focus,
input[type="password"]:focus,
input[type="text"]:focus {
  outline: none;
  background: var(--card);
  border-color: var(--fg);
  box-shadow: 0 0 0 3px var(--ring);
}
.field__input--code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 18px;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.18em;
}

/* Static device-code display on the device-consent screen. */
.device-code {
  margin: 4px 0 18px;
  padding: 14px;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--fg);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}

/* ---------------------------------------------------------------- */
/* Buttons                                                          */
/* ---------------------------------------------------------------- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 11px 20px;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: var(--card);
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 0.12s var(--ease),
    border-color 0.12s var(--ease),
    opacity 0.12s var(--ease),
    transform 0.06s var(--ease);
}
.btn:active {
  transform: translateY(0.5px);
}
.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--ring);
}
.btn:disabled,
.btn[disabled] {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn--primary {
  background: var(--primary);
  color: var(--primary-fg);
  border-color: var(--primary);
}
.btn--primary:hover {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
}

.btn--ghost {
  background: transparent;
  color: var(--fg-muted);
  border-color: transparent;
}
.btn--ghost:hover {
  background: var(--surface-2);
  color: var(--fg);
}

/* Outline / federated-provider / revoke buttons share the quiet
   bordered look. */
.btn--oidc,
.btn--danger {
  background: var(--card);
  color: var(--fg);
  border-color: var(--border);
}
.btn--oidc {
  width: 100%;
}
.btn--oidc:hover,
.btn--danger:hover {
  background: var(--surface-2);
  border-color: var(--border-strong);
}

.btn--lg {
  min-height: 46px;
  font-size: 15px;
}
.btn--sm {
  min-height: 36px;
  padding: 8px 14px;
  font-size: 13px;
}

/* Quiet bordered secondary (Cancel / Back / Deny on stacked actions). */
.btn--outline {
  background: var(--card);
  color: var(--fg);
  border-color: var(--border);
}
.btn--outline:hover {
  background: var(--surface-2);
  border-color: var(--border-strong);
}

/* Destructive — used sparingly. Filled is loud; prefer --danger-quiet. */
.btn--destructive {
  background: var(--destructive);
  color: var(--destructive-fg);
  border-color: var(--destructive);
}
.btn--destructive:hover {
  background: var(--destructive-hover);
  border-color: var(--destructive-hover);
}
/* The default danger affordance: outline button, red text, no red fill. */
.btn--danger-quiet {
  background: var(--card);
  color: var(--destructive);
  border-color: var(--border-strong);
}
.btn--danger-quiet:hover {
  background: var(--error-bg);
  border-color: var(--destructive-soft-border);
  color: var(--destructive-hover);
}

/* ---------------------------------------------------------------- */
/* Separator, federated stack, aux link                             */
/* ---------------------------------------------------------------- */

.separator {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 14px;
  color: var(--fg-faint);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.separator::before,
.separator::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}

.oidc {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.oidc form {
  margin: 0;
}

.aux {
  margin: 20px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--fg-muted);
}
.aux a {
  color: var(--fg);
  font-weight: 500;
}

/* ---------------------------------------------------------------- */
/* Banners / alerts                                                 */
/* ---------------------------------------------------------------- */

.banner,
.alert {
  margin: 0 0 16px;
  padding: 11px 14px;
  border: 1px solid;
  border-radius: var(--r-md);
  font-size: 13px;
  line-height: 1.5;
}
.banner p {
  margin: 0 0 8px;
}
.banner--error,
.alert--error {
  background: var(--error-bg);
  border-color: var(--error-border);
  color: var(--error-fg);
}
.banner--success {
  background: var(--success-bg);
  border-color: var(--success-border);
  color: var(--success-fg);
}
.banner--warn,
.alert--warn {
  background: var(--warn-bg);
  border-color: var(--warn-border);
  color: var(--warn-fg);
}

/* The one-time API-key reveal renders a monospace block. */
.scope-literal {
  display: block;
  width: 100%;
  margin-top: 2px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  color: var(--fg);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  word-break: break-all;
}
.scope-human {
  display: block;
  font-size: 13px;
  color: var(--fg);
}

/* ---------------------------------------------------------------- */
/* Consent screen                                                   */
/* ---------------------------------------------------------------- */

.consent-header {
  margin: 0 0 20px;
}
.consent-title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.3;
}
.consent-lede {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--fg-muted);
}
.client-name,
.consent-lede .client-name {
  color: var(--fg);
  font-weight: 600;
}
.consent-form {
  display: flex;
  flex-direction: column;
}
.consent-footnote {
  margin: 18px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--fg-faint);
}

/* Per-bundle expand view: each bundle is its own collapsible row (see the
   details.bundle-expand block lower down) carrying these summary-text
   classes; expanding a row reveals its granular scope sub-items. */
.bundles {
  display: flex;
  flex-direction: column;
}
.bundle-row__text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.bundle-row__label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.bundle-row__desc {
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg-muted);
}
/* "Other" group: requested scopes that map to no bundle. Visible (so the
   user reads each description) but visually quiet, sitting below the bundle
   rows. */
.bundle--residual {
  border-top: 1px solid var(--hairline);
  padding-top: 8px;
  margin-top: 2px;
}
.bundle-residual__head {
  margin: 4px 0 2px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-faint);
}
.bundle--residual .scope-row {
  padding: 7px 0;
}
.bundle--residual .scope-row__text {
  font-size: 13px;
  color: var(--fg-muted);
}

/* Flat / re-consent-diff grouping (no bundles configured). */
.section {
  margin: 0;
  border-top: 1px solid var(--hairline);
  padding-top: 16px;
}
.section:first-of-type {
  border-top: 0;
  padding-top: 0;
}
details.section > summary {
  list-style: none;
}
details.section > summary::-webkit-details-marker {
  display: none;
}
.section__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 8px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.section__head--static {
  cursor: default;
}
.section__label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg);
}
.section__count {
  margin-left: auto;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
}
.section__chevron {
  width: 8px;
  height: 8px;
  border-right: 1.5px solid var(--fg-faint);
  border-bottom: 1.5px solid var(--fg-faint);
  transform: rotate(-45deg);
  transition: transform 0.16s var(--ease);
  flex-shrink: 0;
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
  line-height: 1.5;
  color: var(--fg-muted);
}
.section--added .section__label {
  color: var(--success-fg);
}
.section--removed .section__label {
  color: var(--fg-muted);
}

.scope-list {
  display: flex;
  flex-direction: column;
  padding-bottom: 4px;
}
.scope-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 0;
  cursor: pointer;
}
.scope-row__text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg);
}
.scope-row--removed {
  cursor: default;
}
.scope-row--removed .scope-row__text {
  color: var(--fg-faint);
  text-decoration: line-through;
}

/* The plain scope list used by the device-consent screen. */
.scopes {
  margin: 0 0 4px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.scopes li {
  font-size: 14px;
  color: var(--fg);
}

/* ---------------------------------------------------------------- */
/* Toggle switch                                                    */
/* ---------------------------------------------------------------- */

.toggle {
  position: relative;
  display: inline-block;
  width: 30px;
  height: 18px;
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
  border-radius: 999px;
  transition: background 0.18s var(--ease);
  pointer-events: none;
}
.toggle__track::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: var(--primary-fg);
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.18s var(--ease);
}
.toggle input:checked + .toggle__track {
  background: var(--primary);
}
.toggle input:checked + .toggle__track::before {
  transform: translateX(12px);
}
.toggle input:focus-visible + .toggle__track {
  box-shadow: 0 0 0 3px var(--ring);
}
.toggle input:disabled + .toggle__track {
  opacity: 0.5;
}

/* ---------------------------------------------------------------- */
/* Action row, unverified badge                                     */
/* ---------------------------------------------------------------- */

.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.actions form {
  margin: 0;
}
.actions .btn,
.actions button {
  width: 100%;
}

.unverified-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-fg);
  white-space: nowrap;
  vertical-align: middle;
}

/* ---------------------------------------------------------------- */
/* List rows (keys + security)                                      */
/* ---------------------------------------------------------------- */

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-top: 1px solid var(--hairline);
}
.row:first-of-type {
  border-top: 0;
}
.row__main {
  flex: 1;
  min-width: 0;
}
.row__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  word-break: break-word;
}
.row__meta {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: var(--fg-muted);
  word-break: break-word;
}
.row__meta--faint {
  color: var(--fg-faint);
}
.row__action {
  margin: 0;
  flex-shrink: 0;
}

.tag {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--fg-muted);
  vertical-align: middle;
}
.tag--current {
  background: var(--border);
  color: var(--fg);
}

/* ---------------------------------------------------------------- */
/* Squared check (rounded square, dark fill + white tick when on)    */
/* ---------------------------------------------------------------- */

.chk {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--border-strong);
  background: var(--card);
  cursor: pointer;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  transition:
    background 0.12s var(--ease),
    border-color 0.12s var(--ease);
}
.chk::after {
  content: "";
  width: 6px;
  height: 10px;
  border: solid var(--card);
  border-width: 0 2px 2px 0;
  border-radius: 1px;
  transform: rotate(45deg) translateY(-1px);
  opacity: 0;
}
.chk:checked {
  background: var(--primary);
  border-color: var(--primary);
}
.chk:checked::after {
  opacity: 1;
}
.chk:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--ring);
}
.chk:disabled {
  cursor: default;
}

/* ---------------------------------------------------------------- */
/* Capability rows ("what it can do" / "this connection can")        */
/* Label leading, squared check trailing.                            */
/* ---------------------------------------------------------------- */

.caps {
  display: flex;
  flex-direction: column;
}
.cap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 11px 0;
}
.cap__text {
  min-width: 0;
}
.cap__title {
  font-size: 14px;
  font-weight: 500;
  color: var(--fg);
}
.cap__desc {
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--fg-muted);
}

/* ---------------------------------------------------------------- */
/* Read-only monospace field (a full type identifier, scopes)        */
/* ---------------------------------------------------------------- */

.codefield {
  width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  padding: 11px 14px;
  color: var(--fg-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  word-break: break-all;
}

/* ---------------------------------------------------------------- */
/* Big code display + entry (device flow)                            */
/* ---------------------------------------------------------------- */

/* Confirm-the-code display: a box that hugs the code. */
.codebox-wrap {
  display: flex;
  justify-content: center;
  margin: 24px 0;
}
.codebox {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.codebox__seg {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 0.14em;
  line-height: 1;
}
.codebox__dash {
  color: var(--fg-faint);
}

/* Enter-the-code: segmented OTP-style cells. */
.otp {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 24px 0;
}
.otp__cell {
  width: 42px;
  height: 52px;
  display: grid;
  place-items: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 24px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--card);
}
.otp__cell--empty {
  background: var(--surface-2);
  color: var(--fg-faint);
}
.otp__cell--active {
  border-color: var(--fg);
  box-shadow: 0 0 0 3px var(--ring);
}
.otp__dash {
  color: var(--fg-faint);
  font-size: 20px;
  padding: 0 2px;
}

/* ---------------------------------------------------------------- */
/* Stepper (two-step sign-up)                                        */
/* ---------------------------------------------------------------- */

.steps {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 20px;
}
.steps__seg {
  height: 4px;
  flex: 1;
  border-radius: 999px;
  background: var(--border);
}
.steps__seg--on {
  background: var(--primary);
}

/* ---------------------------------------------------------------- */
/* Disclosure (install "Technical details", and the like)            */
/* ---------------------------------------------------------------- */

details.disclosure > summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  cursor: pointer;
  color: var(--fg-muted);
  font-size: 13px;
  font-weight: 500;
}
details.disclosure > summary::-webkit-details-marker {
  display: none;
}
details.disclosure .disclosure__chevron {
  width: 8px;
  height: 8px;
  border-right: 1.6px solid currentColor;
  border-bottom: 1.6px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.18s var(--ease);
}
details.disclosure[open] > summary {
  color: var(--fg);
}
details.disclosure[open] > summary .disclosure__chevron {
  transform: rotate(45deg);
}
.disclosure__micro {
  margin: 10px 0 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-faint);
}

/* ---------------------------------------------------------------- */
/* Per-bundle expand (consent): summary row with master toggle,      */
/* granular sub-items behind a per-row chevron, quieter squared.     */
/* ---------------------------------------------------------------- */

details.bundle-expand {
  border-top: 1px solid var(--hairline);
}
details.bundle-expand:first-of-type {
  border-top: 0;
}
details.bundle-expand > summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 0;
  cursor: pointer;
}
details.bundle-expand > summary::-webkit-details-marker {
  display: none;
}
.bundle-expand__chevron {
  width: 7px;
  height: 7px;
  border-right: 1.6px solid var(--fg-faint);
  border-bottom: 1.6px solid var(--fg-faint);
  transform: rotate(-45deg);
  transition: transform 0.18s var(--ease);
  flex-shrink: 0;
}
details.bundle-expand[open] .bundle-expand__chevron {
  transform: rotate(45deg);
}
.bundle-expand__sub {
  padding: 2px 0 18px 2px;
}
.bundle-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 8px 0;
}
.bundle-sub__label {
  font-size: 13px;
  color: var(--fg-muted);
}
.bundle-sub .chk {
  width: 18px;
  height: 18px;
}

/* ---------------------------------------------------------------- */
/* Danger zone + active-session marker (security)                    */
/* ---------------------------------------------------------------- */

.danger-zone {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--hairline);
}
.danger-zone__text {
  min-width: 0;
}
.danger-zone__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.danger-zone__desc {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--fg-muted);
}
.row__title .this-device {
  color: var(--fg-muted);
  font-weight: 500;
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
