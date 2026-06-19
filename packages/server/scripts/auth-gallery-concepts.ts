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
/** Text treatment for the wordmark + tagline over the split's gradient. */
export type SplitInk = "plain" | "blend" | "gloss";

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
      <p class="aux">No account yet? <a href="#">Create one</a></p>
    </div>`;
}

/**
 * The split concept: a modal split into a form half and a soft gradient half,
 * with a card "lip" around the inset panels, the Marfa wordmark top-left of the
 * gradient and a tagline bottom-left. One warm gradient, softened with a white
 * wash (and dimmed in dark mode so it isn't glaring). A dev-only "Flip side"
 * button swaps which half the gradient sits on. The variants differ only in how
 * the wordmark + tagline ink sits over the gradient (plain / inverse / glossy).
 */
export function renderAuthSplit(
  ink: SplitInk,
  mode: AuthMode = "signup",
): string {
  const inkClass =
    ink === "blend"
      ? "ink--blend"
      : ink === "gloss"
        ? "ink--gloss"
        : "ink--plain";
  const art = `<div class="split__art">
      <span class="split__brand ${inkClass}">Marfa</span>
      <span class="split__tagline ${inkClass}">Your personal data workspace.</span>
    </div>`;
  const form = authPanel(mode);
  const title =
    mode === "signup" ? "Create your Marfa account" : "Sign in to Marfa";

  const style = `
    body { padding: 32px 24px; }
    .split {
      position: relative;
      width: min(720px, calc(100% - 32px));
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 26px;
      padding: 10px;
      display: flex;
      gap: 0;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    /* Dev-only: flip which half the gradient occupies. */
    .split.flip { flex-direction: row-reverse; }
    .split > * { flex: 1 1 50%; min-width: 0; }
    .split__form {
      padding: 38px 34px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .split__art {
      position: relative;
      min-height: 340px;
      border-radius: 18px;
      overflow: hidden;
      /* Warm mesh, lightened so it reads soft and dreamy rather than vivid. */
      background:
        radial-gradient(75% 55% at 50% 110%, #ffbe8a 0%, rgba(255,190,138,0) 60%),
        radial-gradient(85% 65% at 78% 88%, #ffaccf 0%, rgba(255,172,207,0) 55%),
        radial-gradient(85% 65% at 22% 72%, #b6ccff 0%, rgba(182,204,255,0) 55%),
        linear-gradient(176deg, #f7f2ec 0%, #efeaf2 34%, #f7d9d1 72%, #ffdab4 100%);
    }
    /* A white wash floats over the gradient to soften it; text sits above it. */
    .split__art::after {
      content: "";
      position: absolute;
      inset: 0;
      background: rgba(255, 255, 255, 0.2);
      pointer-events: none;
    }
    /* Dark mode: dim rather than lighten, so the gradient doesn't glare. */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) .split__art::after { background: rgba(8, 8, 10, 0.42); }
    }
    :root[data-theme="dark"] .split__art::after { background: rgba(8, 8, 10, 0.42); }
    .split__brand {
      position: absolute; top: 22px; left: 24px; z-index: 1;
      font-size: 16px; font-weight: 600; letter-spacing: -0.01em;
    }
    .split__tagline {
      position: absolute; left: 24px; right: 24px; bottom: 22px; z-index: 1;
      font-size: 21px; font-weight: 600; line-height: 1.25; letter-spacing: -0.015em;
    }
    /* Ink treatments over the soft gradient:
       plain — a calm dark ink that reads across the whole wash.
       blend — white set to difference, so it inverts against whatever's behind.
       gloss — white with a layered highlight + shadow for an embossed sheen. */
    .ink--plain { color: #3f3f46; }
    .ink--blend { color: #fff; mix-blend-mode: difference; }
    .ink--gloss {
      color: rgba(255, 255, 255, 0.96);
      text-shadow: 0 1px 0 rgba(255, 255, 255, 0.5), 0 2px 7px rgba(70, 35, 22, 0.3);
    }
    /* Dev-only flip control. */
    .flip-btn {
      position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
      border: 1px solid var(--border); background: var(--card); color: var(--fg-muted);
      font: inherit; font-size: 12px; padding: 6px 13px; border-radius: 999px; cursor: pointer;
    }
    .flip-btn:hover { color: var(--fg); border-color: var(--border-strong); }
    /* Below ~640px the split would crush; drop the gradient half. */
    @media (max-width: 640px) { .split__art { display: none; } }
  `;

  const flipScript = `(function(){var s=document.getElementById('split');var b=document.getElementById('flip-btn');if(s&&b){b.addEventListener('click',function(){s.classList.toggle('flip');});}})();`;

  const body = `<main class="split" id="split" aria-label="${title}">${form}${art}</main>
  <button type="button" class="flip-btn" id="flip-btn">Flip gradient side</button>
  <script>${flipScript}</script>
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

const KEY_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`;
const CHECK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

/**
 * Variants for the "Add a passkey" screen, which felt spaced-out with its
 * "Signed in as" line sitting tight under the description. v1 centers it with a
 * key icon and gives the meta line its own room; v2 spells out the methods as
 * airy check rows.
 */
export function renderPasskeyConcept(variant: "v1" | "v2"): string {
  if (variant === "v1") {
    const body = `<main class="card card--confirm" aria-label="Add a passkey">
      <div class="confirm-icon">${KEY_ICON}</div>
      <h1 class="title">Add a passkey</h1>
      <p class="sub">Sign in faster with Face ID, Touch ID, Windows Hello, or a security key.</p>
      <div class="actions">
        <button type="button" class="btn btn--primary">Add a passkey</button>
      </div>
      <p class="aux">Signed in as <strong>jonah@example.com</strong></p>
      <p class="aux"><a href="#">Back to security</a></p>
    </main>`;
    return conceptDoc("Add a passkey", "", body);
  }
  const methods = [
    "Face ID or Touch ID",
    "Windows Hello",
    "A hardware security key",
  ]
    .map((m) => `<div class="crow">${CHECK}<span>${m}</span></div>`)
    .join("");
  const body = `<main class="card" aria-label="Add a passkey">
    <h1 class="title">Add a passkey</h1>
    <p class="sub">A passkey lets you sign in without a password — it stays on your device.</p>
    <p class="sub">Signed in as <strong>jonah@example.com</strong>.</p>
    <div style="margin:18px 0 2px">${methods}</div>
    <div class="actions">
      <button type="button" class="btn btn--primary">Add a passkey</button>
    </div>
    <p class="aux"><a href="#">Back to security</a></p>
  </main>`;
  return conceptDoc("Add a passkey", "", body);
}

/**
 * Fresh ideas for the OAuth consent screen (with the unverified-app caution).
 * v1 leads with an app-identity header and shows permissions as a read-only
 * checklist; v2 keeps the editable toggles but as plain grouped rows rather
 * than collapsible soft tiles.
 */
export function renderConsentConcept(variant: "v1" | "v2"): string {
  const caution = `<div class="callout"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Marfa hasn't verified this app. Anyone can use this name, so only allow access if you trust it.</span></div>`;
  const actions = `<div class="actions">
      <button type="button" class="btn btn--primary">Allow access</button>
      <button type="button" class="btn btn--ghost">Deny</button>
    </div>`;

  if (variant === "v1") {
    const style = `.apphead{display:flex;gap:13px;align-items:center;margin:2px 0 16px}
      .applogo{width:46px;height:46px;border-radius:13px;background:var(--tile);display:grid;
        place-items:center;font-size:20px;font-weight:600;color:var(--fg);flex:none}
      .appname{font-size:17px;font-weight:600;letter-spacing:-0.01em}
      .appname small{display:block;font-size:13px;font-weight:400;color:var(--fg-muted);margin-top:2px}
      .perm{display:flex;gap:11px;align-items:flex-start;padding:9px 0}
      .perm svg{flex:none;margin-top:2px;color:var(--fg)}
      .perm b{font-size:14px;font-weight:500;color:var(--fg)}
      .perm span{display:block;font-size:13px;color:var(--fg-muted);margin-top:1px}`;
    const perms = (
      [
        ["Read your content", "Notes, tasks, bookmarks, and more."],
        ["Write your content", "Add, edit, and organize what's in your space."],
        ["Your profile", "Your name and email."],
      ] as [string, string][]
    )
      .map(
        ([t, d]) =>
          `<div class="perm">${CHECK}<div><b>${t}</b><span>${d}</span></div></div>`,
      )
      .join("");
    const body = `<main class="card" aria-label="Allow access">
      <div class="apphead">
        <div class="applogo">R</div>
        <div class="appname">Raycast<small>wants to access your space</small></div>
      </div>
      ${caution}
      <div>${perms}</div>
      ${actions}
      <p class="aux">You can change this anytime in settings.</p>
    </main>`;
    return conceptDoc("Allow access", style, body);
  }

  const style = `.grow{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0}
    .grow + .grow{border-top:1px solid var(--hairline)}
    .grow b{font-size:14px;font-weight:500}
    .grow small{display:block;font-size:12.5px;color:var(--fg-muted);font-weight:400;margin-top:1px}
    .gsec{margin:18px 0 2px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--fg-faint)}`;
  const sw = `<label class="sw"><input type="checkbox" checked><span class="tk"></span></label>`;
  const section = (title: string, rows: [string, string][]): string =>
    `<p class="gsec">${title}</p>` +
    rows
      .map(
        ([t, d]) =>
          `<div class="grow"><div><b>${t}</b><small>${d}</small></div>${sw}</div>`,
      )
      .join("");
  const body = `<main class="card" aria-label="Allow access">
    <h1 class="title">Allow access</h1>
    <p class="sub"><b>Raycast</b> wants to access your space.</p>
    ${caution}
    ${section("Read", [
      ["Notes", "Your notes"],
      ["Tasks", "Your tasks and to-dos"],
    ])}
    ${section("Write", [["Notes & tasks", "Add and edit your content"]])}
    ${section("Profile", [["Your profile", "Name and email"]])}
    ${actions}
  </main>`;
  return conceptDoc("Allow access", style, body);
}
