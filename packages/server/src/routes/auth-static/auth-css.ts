/**
 * Auth-surface stylesheet, served from `GET /auth/static/auth.css`.
 *
 * Exported as a TypeScript template literal (rather than a sibling `.css`
 * file) so tsup bundles it into `dist/` without a separate static-asset
 * copy step. Treat the body as plain CSS.
 *
 * Single source of truth for every page built on `renderAuthLayout` rather
 * than the page system: OAuth consent, the device flow, the owner, setup and
 * management pages, the expired authorization page, the root page and the
 * auth error page. Page renderers reference these classes by name and never
 * inline styles.
 *
 * The design is a calm, monochrome "Luma" shadcn surface: a white card on
 * a soft gray canvas, soft-filled pill inputs, near-black primary buttons,
 * a quiet ghost secondary. Colors are the shadcn "neutral" ramp. Tokens
 * are CSS custom properties so an operator can re-theme without
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

  /* Error tint. */
  --error-bg: #fef2f2;
  --error-border: #fecaca;
  --error-fg: #991b1b;

  /* Radii — everything rounded (Luma). */
  --r-pill: 999px;
  --r-card: 26px;
  --r-tile: 16px;
  --r-md: 14px;
  --r-input: 12px;
  --r-sm: 10px;

  /* Vertical rhythm — three steps shared by every screen so the spacing reads
     as one system rather than per-page guesses:
       --gap-pair  binds a title to the sub beneath it (a tight pair).
       --gap-base  the base gap: sub→content, and between form fields.
       --gap-step  the larger step before a primary-action block.
     The field→button gap is --gap-step on EVERY screen; see the .actions
     trim rule below for how the step stays constant regardless of wrapper. */
  --gap-pair: 6px;
  --gap-base: 16px;
  --gap-step: 20px;

  --shadow: 0 1px 2px rgba(10, 10, 10, 0.04), 0 8px 28px rgba(10, 10, 10, 0.06);
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
}

/* Dark tokens, following the device. */
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0a;
    --card: #161616;
    --fg: #fafafa;
    --fg-muted: #a3a3a3;
    --fg-faint: #6e6e6e;
    --border: #2a2a2a;
    --border-strong: #3a3a3a;
    --surface-2: #1f1f1f;
    --tile: #1c1c1c;

    --primary: #fafafa;
    --primary-hover: #e5e5e5;
    --primary-fg: #171717;

    --ring: rgba(250, 250, 250, 0.2);

    --error-bg: #1f1212;
    --error-border: #3d1f1f;
    --error-fg: #fca5a5;

    --shadow: none;
  }
  :root .card {
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
/* Two card widths only: Standard (400, forms/dialogs) and Wide (520, for
   longer scope lists). */
.card--wide {
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

/* Confirmation / result screens (check your email, verified, link expired) —
   center the heading, sub, and a leading icon chip so a content-light card
   reads as deliberate rather than squat. Forms keep their left-aligned labels. */
.card--confirm {
  text-align: center;
}
.card--confirm .form {
  text-align: left;
}
.card--confirm .sub {
  max-width: 34ch;
  margin-left: auto;
  margin-right: auto;
}
.confirm-icon {
  width: 52px;
  height: 52px;
  margin: 2px auto 18px;
  border-radius: 15px;
  background: var(--tile);
  color: var(--fg);
  display: grid;
  place-items: center;
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
/* Field-level error message, rendered under the offending input. Replaces a
   top error banner so the error sits where the eye is. */
.field__error {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--error-fg);
}
/* Form controls share one input treatment, so there is one control shape
   and not three.
   NB: no backticks anywhere in this file. It is a template literal, and a
   backtick in a comment ends the string. */
input[type="email"],
input[type="password"],
input[type="text"],
input[type="number"],
select {
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
/* A select keeps the native control for accessibility and mobile pickers,
   but loses the platform chrome so it sits in the same visual family as the
   inputs above. The chevron is a background image rather than a pseudo
   element, because a replaced element cannot host one. */
select {
  appearance: none;
  -webkit-appearance: none;
  width: auto;
  min-width: 0;
  max-width: 100%;
  padding-right: 34px;
  cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' stroke='%23737373' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 13px center;
}

/* A checkbox takes the accent rather than the browser's default blue. */
input[type="checkbox"] {
  accent-color: var(--primary);
}

input::placeholder {
  color: var(--fg-faint);
}
input[type="email"]:hover,
input[type="password"]:hover,
input[type="text"]:hover,
input[type="number"]:hover,
select:hover {
  border-color: var(--border-strong);
}
input[type="email"]:focus,
input[type="password"]:focus,
input[type="text"]:focus,
input[type="number"]:focus,
select:focus {
  outline: none;
  background: var(--card);
  border-color: var(--fg);
  box-shadow: 0 0 0 3px var(--ring);
}
/* A field carrying a validation error: red border + matching focus ring on its
   input. */
.field--error > input[type="email"],
.field--error > input[type="password"],
.field--error > input[type="text"] {
  border-color: var(--error-border);
}
.field--error > input[type="email"]:focus,
.field--error > input[type="password"]:focus,
.field--error > input[type="text"]:focus {
  border-color: var(--error-fg);
  box-shadow: 0 0 0 3px var(--error-bg);
}
/* ---------------------------------------------------------------- */
/* Buttons                                                          */
/* ---------------------------------------------------------------- */

/* Action hierarchy — one vocabulary across every screen:
     - .btn--primary  the single committing action (Sign in, Allow access,
                      Resend email). Filled, near-black. One per screen.
     - .btn--ghost    the quiet half of a decision PAIR (Deny next to Allow).
                      Borderless but full-width, so it still reads as a button. */

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

/* ---------------------------------------------------------------- */
/* Banners                                                          */
/* ---------------------------------------------------------------- */

.banner {
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
.banner--error {
  background: var(--error-bg);
  border-color: var(--error-border);
  color: var(--error-fg);
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
   rule is what makes the field→button gap identical on every screen that
   uses this stylesheet. */
.form > .actions,
.sub + .actions,
.banner + .actions {
  margin-top: calc(var(--gap-step) - var(--gap-base));
}

/* ================================================================ */
/* Locked design vocabulary                                         */
/* Airy everywhere.                                                 */
/* ================================================================ */

/* Canonical card heading + subtitle. The line saying what the card is
   about lives in .sub, never a footnote. */
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

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
  }
}
`;
