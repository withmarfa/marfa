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

  /* Vertical rhythm — three steps shared by every screen so the spacing reads
     as one system rather than per-page guesses:
       --gap-pair  binds a title to the sub beneath it (a tight pair).
       --gap-base  the base gap: sub→content, and between form fields.
       --gap-step  the larger step before a primary-action block, the
                   "Or continue with" separator, and the footer link.
     The field→button gap is --gap-step on EVERY screen; see the .actions
     trim rule below for how the step stays constant regardless of wrapper. */
  --gap-pair: 6px;
  --gap-base: 16px;
  --gap-step: 20px;

  --shadow: 0 1px 2px rgba(10, 10, 10, 0.04), 0 8px 28px rgba(10, 10, 10, 0.06);
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
}

/* Dark tokens. Applied two ways: by the OS preference when no theme is
   forced (default — matches the prior behavior exactly), and by an explicit
   :root[data-theme="dark"] regardless of OS (so the gallery can force a
   theme). The token list lives once in a custom-property mixin would be
   ideal, but plain CSS can't share a declaration block across a media
   boundary, so the values are stated once here and re-applied below via a
   shared rule reference. */

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
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
  :root:not([data-theme="light"]) .card {
    box-shadow: none;
  }
}

/* Forced dark — applies in any OS mode. */
:root[data-theme="dark"] {
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
:root[data-theme="dark"] .card {
  box-shadow: none;
}

/* Forced light — re-asserts the default light tokens so a page can pin light
   even when the OS prefers dark. The :root block above is the canonical light
   ramp; only the tokens the dark theme overrides need re-stating here. */
:root[data-theme="light"] {
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
  --tile: #f6f6f7;

  --primary: #171717;
  --primary-hover: #2a2a2a;
  --primary-fg: #fafafa;

  --ring: rgba(10, 10, 10, 0.13);

  --destructive: #dc2626;
  --destructive-hover: #b91c1c;
  --destructive-fg: #ffffff;
  --destructive-soft-border: #f3c5bf;

  --success-bg: #f0fdf4;
  --success-border: #bbf7d0;
  --success-fg: #166534;
  --error-bg: #fef2f2;
  --error-border: #fecaca;
  --error-fg: #991b1b;
  --warn-bg: #fffbeb;
  --warn-border: #fde68a;
  --warn-fg: #92400e;
  --callout-bg: #fdf6e3;
  --callout-border: #f3e0a3;
  --callout-fg: #854d0e;
  --callout-icon: #a16207;

  --shadow: 0 1px 2px rgba(10, 10, 10, 0.04), 0 8px 28px rgba(10, 10, 10, 0.06);
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
    /* Top-align on phones. Vertically centering a short card in a tall mobile
       viewport (taller still behind the in-app browser chrome) strands a large
       empty band above the card. */
    align-items: start;
    padding: 24px 16px;
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
  gap: var(--gap-base);
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
/* Field-level error message, rendered under the offending input. Replaces a
   top error banner so the error sits where the eye is. */
.field__error {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--error-fg);
}
/* Form-level error line for an error that isn't tied to a single field
   (e.g. sign-in's wrong email-or-password, which spans both inputs). An
   inline red line, NOT a boxed banner. */
.form__error {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--error-fg);
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
/* A field carrying a validation error: red border + matching focus ring on its
   input. Targets the input directly (and through the password-toggle wrapper,
   which inserts a .pw-wrap between .field and the input). */
.field--error > input[type="email"],
.field--error > input[type="password"],
.field--error > input[type="text"],
.field--error .pw-wrap > input[type="password"],
.field--error .pw-wrap > input[type="text"] {
  border-color: var(--error-border);
}
.field--error > input[type="email"]:focus,
.field--error > input[type="password"]:focus,
.field--error > input[type="text"]:focus,
.field--error .pw-wrap > input[type="password"]:focus,
.field--error .pw-wrap > input[type="text"]:focus {
  border-color: var(--error-fg);
  box-shadow: 0 0 0 3px var(--error-bg);
}
.field__input--code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 18px;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.18em;
}

/* Password show/hide toggle. The button is injected by
   /auth/static/password-toggle.js into a .pw-wrap around each password
   input, so a scripting-disabled client just gets a normal field (no dead
   control). Dark mode falls out of the tokens. */
.pw-wrap {
  position: relative;
  display: block;
}
.pw-wrap input[type="password"],
.pw-wrap input[type="text"] {
  /* Room for the toggle so typed text never runs under the icon. */
  padding-right: 46px;
}
.pw-toggle {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 6px;
  margin: auto 0;
  width: 34px;
  height: 34px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg-faint);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition:
    color 0.12s var(--ease),
    background 0.12s var(--ease);
}
/* The toggle script hides the eye until the field has a value (nothing to
   reveal on an empty field). The author display:inline-flex above outranks
   the UA hidden-attribute rule, so re-assert none here for it to take. */
.pw-toggle[hidden] {
  display: none;
}
.pw-toggle:hover {
  color: var(--fg);
}
.pw-toggle:focus-visible {
  outline: none;
  color: var(--fg);
  box-shadow: 0 0 0 3px var(--ring);
}
.pw-toggle svg {
  display: block;
  width: 20px;
  height: 20px;
}

/* ---------------------------------------------------------------- */
/* Buttons                                                          */
/* ---------------------------------------------------------------- */

/* Action hierarchy — one vocabulary across every screen:
     - .btn--primary  the single committing action (Sign in, Allow access,
                      Resend email). Filled, near-black. One per screen.
     - .btn--outline  a secondary BUTTON for a real choice that isn't the
                      primary (Use a different email). Bordered, neutral.
     - .btn--ghost    the quiet half of a decision PAIR (Deny next to Allow).
                      Borderless but full-width, so it still reads as a button.
     - .btn--oidc     reserved for federated-provider buttons only.
     - .aux a         NOT a button — a navigational / escape link (Back to
                      security, Use a password instead). Clearly lighter than
                      any button so a "go back" never competes with a decision.
   Rule of thumb: a decision is a button; leaving the screen is a link. */

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
  /* A link styled as a button (e.g. "Use a different email") must never carry
     the default anchor underline. */
  text-decoration: none;
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

/* Submitting state — set by submit-state.js on form submit. A small leading
   spinner plus the swapped label keeps the button calm and on-brand; the
   button keeps its size so the layout doesn't jump. The disabled styles above
   handle the dimming once the script also disables the control. */
.btn.is-loading {
  cursor: progress;
}
.btn.is-loading::before {
  content: "";
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: btn-spin 0.6s linear infinite;
  opacity: 0.7;
}
@keyframes btn-spin {
  to {
    transform: rotate(360deg);
  }
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

/* "Or continue with" separator — a hairline rule with a centered label.
   20px of breathing room above and below. */
.separator {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: var(--gap-step) 0;
  font-size: 12px;
  color: var(--fg-faint);
}
.separator::before,
.separator::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}

/* Alternatives row — equal-width buttons sitting side by side (one-time link,
   passkey). Each child is a .btn that flexes to fill, so when one is hidden
   the other expands to the full row width and the layout stays balanced. */
.alts {
  display: flex;
  gap: var(--gap-base);
}
.alts > * {
  flex: 1;
}
.alts .btn {
  width: 100%;
  border-color: var(--border);
}
.alts .btn:hover {
  background: var(--surface-2);
  border-color: var(--border-strong);
}

.aux {
  margin: var(--gap-step) 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--fg-muted);
}
/* Aux links lean on weight + color, not an underline, to match the design
   ("Create one", "Use a password instead"). Underline returns on hover as a
   quiet affordance. */
.aux a {
  color: var(--fg);
  font-weight: 500;
  text-decoration: none;
}
.aux a:hover {
  text-decoration: underline;
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
  margin-top: var(--gap-step);
}
.actions form {
  margin: 0;
}
.actions .btn,
.actions button {
  width: 100%;
}
/* The primary-action block sits one --gap-step (20px) below the content above
   it, on every screen. When it directly follows something that already
   contributes its own trailing space — a flex .form's column-gap, or the
   bottom margin of a .sub / .banner immediately above it — subtract that base
   gap so the step stays a single 20px instead of stacking to 36px. This one
   rule is what makes the field→button gap identical across sign-in, sign-up,
   one-time-link, reset, verify-email, and the device flow. */
.form > .actions,
.sub + .actions,
.banner + .actions {
  margin-top: calc(var(--gap-step) - var(--gap-base));
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

/* Muted small line under a section label — used by the consent re-consent
   diff's "No longer needed" group to list dropped capabilities as a quiet
   line rather than toggle rows. */
.rmeta {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg-muted);
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
  margin: 0 0 var(--gap-pair);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.3;
  color: var(--fg);
}
.sub {
  margin: 0 0 var(--gap-base);
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg-muted);
}
.sub b,
.sub strong {
  color: var(--fg);
  font-weight: 600;
}
/* Two stacked .sub lines (e.g. a subtitle plus a "Signed in as …" line on
   passkey-enroll / security) would otherwise double the gap. Pull the second
   up so the pair reads as one block. */
.sub + .sub {
  margin-top: -10px;
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
