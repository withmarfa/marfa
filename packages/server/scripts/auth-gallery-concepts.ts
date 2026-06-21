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
 * than collapsible soft tiles; v3 is a compact one-line summary that hides the
 * detail behind a disclosure.
 */
export function renderConsentConcept(variant: "v1" | "v2" | "v3"): string {
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

  if (variant === "v3") {
    const style = `.applogo{width:46px;height:46px;border-radius:13px;background:var(--tile);display:grid;
        place-items:center;font-size:20px;font-weight:600;color:var(--fg);flex:none;margin:2px auto 16px}
      .summary{font-size:14px;line-height:1.55;color:var(--fg-muted);max-width:34ch;margin:0 auto 4px}
      details.disc{margin:14px 0 2px;text-align:left}
      details.disc>summary{list-style:none;cursor:pointer;font-size:13px;font-weight:500;color:var(--fg-muted);
        text-align:center;padding:8px}
      details.disc>summary::-webkit-details-marker{display:none}
      .drow{display:flex;gap:10px;align-items:flex-start;padding:7px 0}
      .drow svg{flex:none;margin-top:2px;color:var(--fg)}
      .drow span{font-size:13.5px;color:var(--fg)}`;
    const detail = (
      [
        "Read your content",
        "Write your content",
        "Your name and email",
      ] as string[]
    )
      .map((t) => `<div class="drow">${CHECK}<span>${t}</span></div>`)
      .join("");
    const body = `<main class="card card--confirm" aria-label="Allow access">
      <div class="applogo">R</div>
      <h1 class="title">Allow Raycast?</h1>
      <p class="summary">It wants to read and write your content, and see your name and email.</p>
      ${caution}
      <details class="disc"><summary>What it can access</summary>${detail}</details>
      ${actions}
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

/**
 * A fresh take on the device "enter code" screen: the code reads as individual
 * segmented cells rather than one monospace field.
 */
export function renderDeviceConcept(): string {
  const style = `
    .codegrid { display: flex; gap: 8px; justify-content: center; margin: 8px 0 2px; }
    .codegrid .cell {
      width: 44px; height: 56px; border: 1px solid var(--border); border-radius: 12px;
      display: grid; place-items: center; background: var(--card);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 24px; font-weight: 600; color: var(--fg);
    }
    .codegrid .cell.filled { border-color: var(--fg); }
    .codegrid .dash { align-self: center; color: var(--fg-faint); font-size: 20px; }
  `;
  const cells = "BDRF7H2K"
    .split("")
    .map(
      (c, i) =>
        `${i === 4 ? '<span class="dash">–</span>' : ""}<div class="cell filled">${c}</div>`,
    )
    .join("");
  const body = `<main class="card card--confirm" aria-label="Sign in on your device">
    <h1 class="title">Enter the code</h1>
    <p class="sub">Type the code shown on your other device.</p>
    <div class="codegrid">${cells}</div>
    <div class="actions"><button type="button" class="btn btn--primary">Continue</button></div>
  </main>`;
  return conceptDoc("Sign in on your device", style, body);
}
