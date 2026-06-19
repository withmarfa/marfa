/**
 * Design-variant renderers for the auth gallery — dev-only, never shipped.
 *
 * These are NOT the production renderers (those live in `src/routes/*-page.ts`).
 * They're alternative design directions for an EXISTING screen, surfaced in the
 * gallery's right column under a "Variant" group beneath that screen's states.
 * Each returns a full HTML document that links the real `/auth/static/auth.css`
 * (so type, buttons, and fields match the shipped design language) plus a small
 * inline `<style>` for the variant-only layout.
 *
 * Variants are named v1 / v2 / v3 so "show me the variants" is a consistent,
 * repeatable move across every screen that has them.
 */

export type ConceptVariant = "v1" | "v2" | "v3";
export type AuthMode = "signin" | "signup";

/** Wrap variant markup in a full document that links the shared auth stylesheet. */
function conceptDoc(title: string, style: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/auth/static/auth.css">
<style>${style}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** The sign-in / sign-up form that fills the split concept's content panel. */
function authPanel(mode: AuthMode): string {
  if (mode === "signup") {
    return `
    <div class="split__form">
      <h1 class="title">Create your Marfa account</h1>
      <p class="sub">Start your space in seconds.</p>
      <form class="form" novalidate onsubmit="return false">
        <label class="field">
          <span class="field__label">Email</span>
          <input type="email" autocomplete="email">
        </label>
        <label class="field">
          <span class="field__label">Password</span>
          <input type="password" autocomplete="new-password">
        </label>
        <div class="actions">
          <button type="submit" class="btn btn--primary">Sign up</button>
        </div>
      </form>
      <p class="aux">Already have an account? <a href="#">Sign in</a></p>
    </div>`;
  }
  return `
    <div class="split__form">
      <h1 class="title">Sign in to Marfa</h1>
      <p class="sub">Welcome back.</p>
      <form class="form" novalidate onsubmit="return false">
        <label class="field">
          <span class="field__label">Email</span>
          <input type="email" autocomplete="email">
        </label>
        <label class="field">
          <span class="field__label">Password</span>
          <input type="password" autocomplete="current-password">
        </label>
        <div class="actions">
          <button type="submit" class="btn btn--primary">Sign in</button>
        </div>
      </form>
      <div class="separator">Or continue with</div>
      <div class="alts">
        <button type="button" class="btn">One-time link</button>
        <button type="button" class="btn">Passkey</button>
      </div>
      <p class="aux">No account yet? <a href="#">Create one</a></p>
    </div>`;
}

/**
 * The split concept: a double-width modal split into a form half and a gradient
 * half, with an 8px "lip" of card around the inset panels, the Marfa wordmark
 * top-left of the gradient and a tagline bottom-left. Variants change the
 * gradient palette and which side it sits on.
 */
export function renderAuthSplit(
  variant: ConceptVariant,
  mode: AuthMode,
): string {
  // side: which half the gradient occupies. dark: dark ink for the pale v3
  // gradient (white ink would vanish on it).
  const cfg: Record<ConceptVariant, { side: "left" | "right"; dark: boolean }> =
    {
      v1: { side: "right", dark: false },
      v2: { side: "left", dark: false },
      v3: { side: "right", dark: true },
    };
  const c = cfg[variant];
  const ink = c.dark ? " split__ink--dark" : "";
  const art = `<div class="split__art art--${variant}">
      <span class="split__brand${ink}">Marfa</span>
      <span class="split__tagline${ink}">Your personal data workspace.</span>
    </div>`;
  const form = authPanel(mode);
  const inner = c.side === "left" ? art + form : form + art;
  const title =
    mode === "signup" ? "Create your Marfa account" : "Sign in to Marfa";

  const style = `
    body { padding: 32px 24px; }
    .split {
      width: min(880px, calc(100% - 24px));
      min-height: 540px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 28px;
      padding: 8px;
      display: flex;
      gap: 0;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .split > * { flex: 1 1 50%; min-width: 0; }
    .split__form {
      padding: 48px 44px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .split__art {
      position: relative;
      border-radius: 21px;
      overflow: hidden;
    }
    .split__brand {
      position: absolute; top: 24px; left: 26px;
      font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: #fff;
    }
    .split__tagline {
      position: absolute; left: 26px; right: 26px; bottom: 24px;
      font-size: 22px; font-weight: 600; line-height: 1.25;
      letter-spacing: -0.015em; color: #fff;
    }
    .split__ink--dark { color: #3f3f46; }
    /* v1 — warm, soft mesh (cream → blue → pink → peach). */
    .art--v1 {
      background:
        radial-gradient(75% 55% at 50% 108%, #ffb074 0%, rgba(255,176,116,0) 60%),
        radial-gradient(85% 65% at 78% 88%, #ff9ec6 0%, rgba(255,158,198,0) 55%),
        radial-gradient(85% 65% at 22% 72%, #a8c3ff 0%, rgba(168,195,255,0) 55%),
        linear-gradient(176deg, #f4efe6 0%, #e8e2ee 34%, #f4ccc2 72%, #ffcc9e 100%);
    }
    /* v2 — Marfa brand (purple → magenta → orange), diagonal. */
    .art--v2 {
      background:
        radial-gradient(80% 60% at 18% 16%, #9b6bff 0%, rgba(155,107,255,0) 58%),
        radial-gradient(85% 70% at 82% 90%, #ff8a4c 0%, rgba(255,138,76,0) 58%),
        linear-gradient(150deg, #7d5cff 0%, #c95fae 46%, #ff8347 100%);
    }
    /* v3 — quiet grey-violet, a calmer enterprise take. */
    .art--v3 {
      background:
        radial-gradient(70% 60% at 72% 22%, #ece7f6 0%, rgba(236,231,246,0) 60%),
        radial-gradient(70% 70% at 30% 92%, #efe6ec 0%, rgba(239,230,236,0) 60%),
        linear-gradient(170deg, #f4f2f8 0%, #eae9f1 52%, #f0e8ec 100%);
    }
    /* Below ~720px the split would crush; drop the gradient half so the form
       stays legible at narrow frame widths. */
    @media (max-width: 720px) {
      .split { min-height: 0; }
      .split__art { display: none; }
    }
  `;

  const body = `<main class="split" aria-label="${title}">${inner}</main>
  <script src="/auth/static/password-toggle.js"></script>
  <script src="/auth/static/submit-state.js"></script>`;
  return conceptDoc(title, style, body);
}

/**
 * Variants for the content-light "Check your email" confirmation, which reads a
 * little squat as a plain wide card. v1 is today's screen; v2 adds a mail icon
 * chip; v3 centers everything with more room and a larger icon.
 */
export function renderCheckEmail(variant: ConceptVariant): string {
  const MAIL = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;
  const sub = `A one-time sign-in link is on its way. Open it to finish signing in.`;
  const actions = `
      <div class="actions">
        <a href="#" class="btn btn--outline">Use a different email</a>
      </div>
      <p class="aux"><a href="#">Use a password instead</a></p>`;

  let card: string;
  let style = "";
  if (variant === "v1") {
    card = `
      <h1 class="title">Check your email</h1>
      <p class="sub" role="status">${sub}</p>${actions}`;
  } else if (variant === "v2") {
    style = `.mailchip{width:44px;height:44px;border-radius:13px;background:var(--tile);
      color:var(--fg);display:grid;place-items:center;margin:0 0 16px}`;
    card = `
      <div class="mailchip">${MAIL}</div>
      <h1 class="title">Check your email</h1>
      <p class="sub" role="status">${sub}</p>${actions}`;
  } else {
    style = `.card{text-align:center;padding:36px 28px}
      .card .actions .btn{margin:0 auto}
      .mailchip{width:56px;height:56px;border-radius:16px;background:var(--tile);
      color:var(--fg);display:grid;place-items:center;margin:0 auto 20px}
      .card .sub{max-width:30ch;margin-left:auto;margin-right:auto}`;
    card = `
      <div class="mailchip">${MAIL}</div>
      <h1 class="title">Check your email</h1>
      <p class="sub" role="status">${sub}</p>${actions}`;
  }

  const body = `<main class="card" aria-label="Check your email">${card}</main>`;
  return conceptDoc("Check your email", style, body);
}

/**
 * Variants for the two-step sign-up's progress indicator, which currently reads
 * as two heavy bars hard against the card's top edge. v1 is today; v2 is a
 * thinner, lighter bar; v3 drops the bar for a quiet "Step 1 of 2" caption.
 */
export function renderStepperConcept(variant: ConceptVariant): string {
  let stepper: string;
  let style = "";
  if (variant === "v1") {
    stepper = `<div class="steps">
      <span class="steps__seg steps__seg--on"></span>
      <span class="steps__seg"></span>
    </div>`;
  } else if (variant === "v2") {
    style = `.steps{margin:0 0 22px}
      .steps__seg{height:3px;background:var(--hairline)}
      .steps__seg--on{background:var(--fg)}`;
    stepper = `<div class="steps">
      <span class="steps__seg steps__seg--on"></span>
      <span class="steps__seg"></span>
    </div>`;
  } else {
    style = `.stepcap{margin:0 0 10px;font-size:12px;font-weight:600;
      letter-spacing:0.04em;text-transform:uppercase;color:var(--fg-faint)}`;
    stepper = `<p class="stepcap">Step 1 of 2</p>`;
  }

  const card = `
    ${stepper}
    <h1 class="title">Create your Marfa account</h1>
    <p class="sub">Tell us who you are.</p>
    <form class="form" novalidate onsubmit="return false">
      <label class="field"><span class="field__label">Email</span>
        <input type="email" autocomplete="email"></label>
      <label class="field"><span class="field__label">Display name</span>
        <input type="text" autocomplete="name"></label>
      <label class="field"><span class="field__label">Username</span>
        <input type="text" autocomplete="username"></label>
      <div class="actions">
        <button type="submit" class="btn btn--primary">Continue</button>
      </div>
    </form>
    <p class="aux">Already have an account? <a href="#">Sign in</a></p>`;

  const body = `<main class="card" aria-label="Create your Marfa account">${card}</main>`;
  return conceptDoc("Create your Marfa account", style, body);
}
