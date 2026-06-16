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
  /* Soft tile fill — the only boxed surface, reserved for permission
     groups. A hair off the canvas so a tile reads as grouped without a
     border. */
  --tile: #f6f6f7;

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

  /* Callout — the single boxed caution (unverified app). A warmer amber
     than the status --warn tints so it reads as advisory, not error. */
  --callout-bg: #fdf6e3;
  --callout-border: #f3e0a3;
  --callout-fg: #854d0e;
  --callout-icon: #a16207;

  /* Radii — everything rounded (Luma). */
  --r-pill: 999px;
  --r-card: 26px;
  --r-lg: 18px;
  --r-tile: 16px;
  --r-md: 14px;
  --r-input: 12px;
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
    --tile: #1c1c1c;

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
    --callout-bg: #241f10;
    --callout-border: #4a3f1c;
    --callout-fg: #e9c46a;
    --callout-icon: #d4a73a;

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
/* Two card widths only: Standard (400, forms/dialogs) and Wide (520,
   management pages — security, keys). --wide and --lg are aliases. */
.card--wide,
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
  padding: 11px 14px;
  color: var(--fg);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-input);
  transition:
    border-color 0.12s var(--ease),
    box-shadow 0.12s var(--ease);
}
input::placeholder {
  color: var(--fg-faint);
}
input[type="email"]:hover,
input[type="password"]:hover,
input[type="text"]:hover {
  border-color: var(--border-strong);
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

/* ---------------------------------------------------------------- */
/* Buttons                                                          */
/* ---------------------------------------------------------------- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 38px;
  padding: 9px 18px;
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
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
  min-height: 32px;
  padding: 6px 14px;
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
/* Federated provider stack, aux link                               */
/* ---------------------------------------------------------------- */

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

/* ---------------------------------------------------------------- */
/* Consent screen                                                   */
/* ---------------------------------------------------------------- */

.consent-form {
  display: flex;
  flex-direction: column;
}

/* ---------------------------------------------------------------- */
/* Stacked action row (Allow/Deny, Continue/Cancel, …)              */
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

/* ---------------------------------------------------------------- */
/* List rows (keys + security)                                      */
/* ---------------------------------------------------------------- */

/* Management list rows (keys, security) — airy, no dividers; whitespace
   and the bold title carry the separation. */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 0;
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
/* Active-session marker (security)                                  */
/* ---------------------------------------------------------------- */

.row__title .this-device {
  color: var(--fg-muted);
  font-weight: 500;
}

/* ================================================================ */
/* Locked design vocabulary                                         */
/* Soft Tiles for permission groups only; airy everywhere else.     */
/* ================================================================ */

/* Canonical card heading + subtitle. The reassurance line ("you can
   change this anytime in settings") lives in .sub, never a footnote. */
.title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.3;
  color: var(--fg);
}
.sub {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg-muted);
}
.sub b,
.sub strong {
  color: var(--fg);
  font-weight: 600;
}

/* Inline section label inside a panel ("Connected apps", "New", …) —
   sentence case, not a shouty uppercase eyebrow. */
.lsec {
  margin: 18px 0 2px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}

/* The single boxed caution — the unverified-app warning. One warning,
   never a second inline badge. */
.callout {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0 0 16px;
  padding: 11px 13px;
  background: var(--callout-bg);
  border: 1px solid var(--callout-border);
  border-radius: 13px;
}
.callout svg {
  flex: none;
  margin-top: 1px;
  color: var(--callout-icon);
}
.callout span {
  font-size: 13px;
  line-height: 1.45;
  color: var(--callout-fg);
}

/* Permission groups — collapsible Soft Tiles, the ONLY boxed surface.
   Collapsed by default; expand to per-type toggles. */
.t-soft {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.grp {
  background: var(--tile);
  border-radius: var(--r-tile);
}
.grp > summary {
  list-style: none;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 15px;
  cursor: pointer;
}
.grp > summary::-webkit-details-marker {
  display: none;
}
.gmain {
  flex: 1;
  min-width: 0;
}
.gtop {
  display: flex;
  align-items: center;
  gap: 6px;
}
.glabel {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.gchev {
  width: 13px;
  height: 13px;
  color: var(--fg-faint);
  transition: transform 0.18s var(--ease);
  flex: none;
}
.grp[open] .gchev {
  transform: rotate(90deg);
}
.gdesc {
  margin-top: 3px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg-muted);
}
.gsub {
  display: flex;
  flex-direction: column;
  padding: 0 15px 12px;
}
.subrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 8px 0;
}
.subrow > span {
  font-size: 13.5px;
  color: var(--fg);
}

/* "New" chip for a re-consent group (used sparingly — the section
   headers carry most of the diff). */
.newchip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  background: var(--success-bg);
  color: var(--success-fg);
}

/* Switch used inside permission groups. Supports indeterminate for a
   partially-ticked group master. */
.sw {
  position: relative;
  width: 32px;
  height: 19px;
  flex: none;
}
.sw input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: pointer;
  z-index: 1;
}
.sw .tk {
  position: absolute;
  inset: 0;
  background: var(--border-strong);
  border-radius: 999px;
  transition: background 0.16s var(--ease);
  pointer-events: none;
}
.sw .tk::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  background: var(--primary-fg);
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.16s var(--ease);
}
.sw input:checked + .tk {
  background: var(--primary);
}
.sw input:checked + .tk::before {
  transform: translateX(13px);
}
.sw input:indeterminate + .tk {
  background: var(--border-strong);
}
.sw input:focus-visible + .tk {
  box-shadow: 0 0 0 3px var(--ring);
}

/* "+" icon button (new key) and other compact icon actions. */
.iconbtn {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  display: grid;
  place-items: center;
  cursor: pointer;
  color: var(--fg);
  flex: none;
}
.iconbtn:hover {
  background: var(--surface-2);
  border-color: var(--border-strong);
}
.iconbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--ring);
}

/* Panel header: title left, an icon action right. */
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 6px;
}

/* App identity header (integration install). */
.apphead {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.logo {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: var(--tile);
  display: grid;
  place-items: center;
  font-weight: 600;
  font-size: 16px;
  color: var(--fg);
  flex: none;
}
.eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}

/* Capability tile — a soft tile describing what an install adds. */
.captile {
  background: var(--tile);
  border-radius: var(--r-tile);
  padding: 14px 16px;
}
.captile__t {
  font-size: 14px;
  font-weight: 500;
  color: var(--fg);
}
.captile__d {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--fg-muted);
}

/* Capability check rows (device approve) — airy, leading check glyph. */
.crow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}
.crow svg {
  flex: none;
  color: var(--fg);
}
.crow span {
  font-size: 14px;
  color: var(--fg);
}

/* Code display tile (device approve) — soft tile, centered mono. */
.codetile {
  background: var(--tile);
  border-radius: var(--r-tile);
  padding: 18px;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--fg);
}

/* One-line secret reveal (a created API key). Full value on one line,
   smaller mono, truncated, with a trailing copy button. The caution
   sits BELOW the field. */
.copyfield {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 0 6px 0 12px;
  height: 42px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-input);
}
.copyfield__val {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.copyfield__copy {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  display: grid;
  place-items: center;
  cursor: pointer;
  color: var(--fg-muted);
}
.copyfield__copy:hover {
  background: var(--surface-2);
  color: var(--fg);
}
.caution {
  margin: 14px 0 0;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--fg-muted);
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
