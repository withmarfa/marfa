/**
 * Auth-surface stylesheet, served from `GET /auth/static/auth.css`.
 *
 * Exported as a TypeScript template literal (rather than a sibling `.css`
 * file) so tsup bundles it into `dist/` without a separate static-asset
 * copy step. Treat the body as plain CSS.
 *
 * Single source of truth for every `/auth/*` page (sign-in, OAuth consent,
 * device flow, signed out, the error pages). Page renderers
 * reference these classes by name and never inline styles.
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

  /* Callout — the single boxed caution (unverified app). Amber so it reads
     as advisory, not error. */
  --callout-bg: #fdf6e3;
  --callout-border: #f3e0a3;
  --callout-fg: #854d0e;
  --callout-icon: #a16207;

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
    --callout-bg: #241f10;
    --callout-border: #4a3f1c;
    --callout-fg: #e9c46a;
    --callout-icon: #d4a73a;

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
/* Form-level error line for an error that isn't tied to a single field
   (e.g. sign-in's wrong email-or-password, which spans both inputs). An
   inline red line, NOT a boxed banner. */
.form__error {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
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

/* Segmented one-time-code cells (device flow). JS-enhanced from the single
   code input, which stays as the no-JS fallback. A filled cell takes the soft
   tile fill (matching the device-approve code tile) rather than a hard outline,
   so a typed code reads as soft chips, not boxed letters. */
.otp {
  display: flex;
  gap: 6px;
  justify-content: center;
}
/* Scoped under .otp so these beat the base input[type="text"] rule (which
   would otherwise force full width + the field padding and clip the glyph).
   The cells flex to share the row and shrink on narrow cards (capped on wide),
   so eight of them plus the dash always fit inside the card without widening it. */
.otp .otp__cell {
  flex: 1 1 0;
  min-width: 0;
  max-width: 36px;
  height: 46px;
  padding: 0;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 19px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--fg);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-input);
  transition:
    border-color 0.12s var(--ease),
    background 0.12s var(--ease),
    box-shadow 0.12s var(--ease);
}
.otp .otp__cell--filled {
  background: var(--tile);
  border-color: var(--border-strong);
}
.otp .otp__cell:focus {
  outline: none;
  border-color: var(--fg);
  box-shadow: 0 0 0 3px var(--ring);
}
.otp__dash {
  align-self: center;
  color: var(--fg-faint);
  font-size: 18px;
}
.field--error .otp .otp__cell {
  border-color: var(--error-border);
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
   rule is what makes the field→button gap identical across sign-in, sign-up,
   one-time-link, reset, verify-email, and the device flow. */
.form > .actions,
.sub + .actions,
.banner + .actions {
  margin-top: calc(var(--gap-step) - var(--gap-base));
}

/* Muted small line under a section label — used by the consent re-consent
   diff's "No longer needed" group to list dropped capabilities as a quiet
   line rather than toggle rows. */
.subrow .rmeta {
  display: block;
}
.rmeta {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg-muted);
}

/* ================================================================ */
/* Locked design vocabulary                                         */
/* Soft Tiles for permission groups only; airy everywhere else.     */
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

/* Inline section label inside a panel ("Connected apps", "New", …) —
   sentence case, not a shouty uppercase eyebrow. The bottom gap gives the
   grouped tiles below a little breathing room rather than sitting tight. */
.lsec {
  margin: 18px 0 10px;
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
.grp[open] .gchev,
.ksec[open] .gchev {
  transform: rotate(90deg);
}

/* The standing grant on the re-consent screen, collapsed to its heading so
   the reader reaches the buttons. Deliberately not a .grp: the tiles inside
   it are, and a tile holding tiles reads as a nesting that means nothing.

   Its controls stay in the DOM while it is shut, which is load-bearing
   rather than incidental. They are the standing grant, they are ticked, and
   a closed details element still submits them, so an untouched Continue is
   the no-op it looks like. Swap this for anything that removes or disables them
   and the same Continue submits a narrowing, which the decision route reads
   as a promise that the removed access stops working. */
.ksec > summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  margin: 18px 0 10px;
}
.ksec > summary::-webkit-details-marker {
  display: none;
}
.kcount {
  font-size: 13px;
  color: var(--fg-muted);
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

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
  }
}
`;
