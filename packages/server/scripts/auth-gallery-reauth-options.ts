/**
 * Three presentation options for the re-authorisation surface, for the
 * operator to choose between. Gallery-only: nothing here is mounted, and
 * whichever option is picked becomes real code in `src/routes/`.
 *
 * **The situation all three answer.** Someone is signed in. The app they are
 * opening now needs scopes their standing grant does not carry, because the
 * platform's type registry moved. Today they meet a red wall of machine
 * text; the question is what they should meet instead, and — the part that
 * matters beyond this bug — which side of the platform/application line
 * owns the answer.
 *
 * **What is already settled and is not up for choosing.** The platform owns
 * the authorize decision, consent, re-consent, and the machine-readable
 * error contract; `error_description` is developer-facing by RFC 6749
 * §4.1.2.1 and stays that way. The application owns what a person sees at
 * its own redirect URI. What is missing is a platform-hosted recovery
 * surface an app can send someone to, so that every third-party app does not
 * have to invent one — and the three options differ mainly in how much of
 * that the platform provides.
 *
 * All three use the real `renderAuthLayout` and the real stylesheet, so what
 * is on screen is what would ship.
 */
import { renderAuthLayout } from "../src/routes/auth-layout.js";
import { confirmIcon, escapeHtml } from "../src/routes/auth-html.js";

const APP_NAME = "Marfa Web";
const NEW_PERMISSIONS = ["Episodes", "Series"];

/**
 * Option A — the platform hosts the recovery.
 *
 * Marfa renders the whole thing, in its own layout, with a primary action
 * that continues the flow rather than sending the person back to the start.
 * The app's callback error path becomes a thin redirect here.
 *
 * The case for it: one implementation, correct for every client including
 * third parties who would otherwise each invent their own. The case against:
 * the person is bounced out of the app's own shell to a Marfa-branded page
 * mid-flow, which for a first-party app is a seam that did not need to exist.
 */
export function renderOptionA(): string {
  const items = NEW_PERMISSIONS.map(
    (p) => `<li class="scope-row"><span>${escapeHtml(p)}</span></li>`,
  ).join("");
  return renderAuthLayout({
    title: `${APP_NAME} needs updated access`,
    bodyHtml: `
      <h1 class="title">${escapeHtml(APP_NAME)} needs updated access</h1>
      <p class="sub">Marfa has added new kinds of content since you last signed in. Approving takes a moment and you will not need to sign in again.</p>
      <p class="lsec" style="margin-top:8px">New</p>
      <ul class="t-soft" style="list-style:none;padding:0;margin:0">${items}</ul>
      <div class="actions" style="margin-top:18px">
        <a href="#" class="btn btn--primary">Review and approve</a>
      </div>
      <p class="caution">You can change what ${escapeHtml(APP_NAME)} can reach at any time from your security settings.</p>
    `,
  });
}

/**
 * Option B — the app renders it, the platform tells it what to say.
 *
 * The platform returns a structured, machine-readable outcome plus a
 * recovery URL; the application maps that to its own copy inside its own
 * shell. This mock stands in for the application's design, which is why it
 * deliberately does not look like the pages above.
 *
 * The case for it: the person never leaves the app, and the app can phrase
 * the ask in its own voice and at the right moment. The case against: every
 * client has to implement it, and the one that does not gets today's
 * behaviour — a raw error string on a dead-end page. That is precisely how
 * the current bug reached a person.
 */
export function renderOptionB(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(APP_NAME)}</title>
  <style>
    :root{color-scheme:light dark}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;grid-template-columns:220px 1fr;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
      background:#fbfbfb;color:#0a0a0a;font-size:14px}
    @media (prefers-color-scheme:dark){body{background:#0d0d0d;color:#fafafa}}
    .side{border-right:1px solid #e6e6e6;padding:18px 14px;display:flex;flex-direction:column;gap:6px}
    @media (prefers-color-scheme:dark){.side{border-color:#242424}}
    .brand{font-weight:650;letter-spacing:-.02em;margin-bottom:10px}
    .nav{color:#8a8a8a;padding:6px 8px;border-radius:8px}
    .nav--on{background:#eee;color:inherit}
    @media (prefers-color-scheme:dark){.nav--on{background:#1e1e1e}}
    .main{display:grid;place-items:center;padding:40px 24px}
    .panel{max-width:420px;text-align:center}
    .icon{width:40px;height:40px;border-radius:12px;background:#eee;display:grid;place-items:center;margin:0 auto 14px}
    @media (prefers-color-scheme:dark){.icon{background:#1e1e1e}}
    h1{font-size:19px;font-weight:650;letter-spacing:-.02em;margin:0 0 8px}
    p{margin:0 0 8px;color:#6d6d6d;line-height:1.55}
    @media (prefers-color-scheme:dark){p{color:#9a9a9a}}
    .cta{display:inline-block;margin-top:14px;background:#171717;color:#fafafa;
      text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:550}
    @media (prefers-color-scheme:dark){.cta{background:#fafafa;color:#171717}}
  </style>
</head>
<body>
  <nav class="side">
    <div class="brand">${escapeHtml(APP_NAME)}</div>
    <div class="nav nav--on">Library</div>
    <div class="nav">Search</div>
    <div class="nav">Collections</div>
    <div class="nav">Settings</div>
  </nav>
  <main class="main">
    <div class="panel">
      <div class="icon">🔑</div>
      <h1>One quick approval</h1>
      <p>Marfa added new kinds of content — ${escapeHtml(NEW_PERMISSIONS.join(" and "))} — and this app needs your say-so before it can show them.</p>
      <p>Everything else keeps working in the meantime.</p>
      <a class="cta" href="#">Approve in Marfa</a>
    </div>
  </main>
</body>
</html>`;
}

/**
 * Option C — there is no error, because this is not a failure.
 *
 * A scope change is a consent diff. The person lands on the re-consent
 * screen the platform already has, sees what is new, and approves. An error
 * surface appears only when the request is genuinely unrecoverable — an
 * unknown client, a request nobody signed.
 *
 * The case for it: it is the least new surface area, it reuses a screen that
 * already exists and already does the right thing, and it treats the
 * situation as what it is rather than as a fault. **Narrowing, already
 * shipped, is what makes it reachable at all** — the bug was never that this
 * screen was wrong, it was that nobody could get to it. The case against: it
 * says nothing about *why* the ask appeared, which for a person who has used
 * the app for months may read as arbitrary.
 *
 * This mock renders the diff shape the real consent screen uses.
 */
export function renderOptionC(): string {
  const added = NEW_PERMISSIONS.map(
    (p) =>
      `<li class="scope-row"><label><input type="checkbox" class="chk" checked> <span>${escapeHtml(p)}</span></label></li>`,
  ).join("");
  const kept = ["Notes", "Tasks", "Bookmarks", "Files"]
    .map((p) => `<li class="scope-row"><span>${escapeHtml(p)}</span></li>`)
    .join("");
  return renderAuthLayout({
    title: `Continue to ${APP_NAME}`,
    wide: true,
    bodyHtml: `
      <h1 class="title">${escapeHtml(APP_NAME)} is asking for a little more</h1>
      <p class="sub">You have used this app before. Since then Marfa has added new kinds of content, so it needs your approval for those.</p>

      <p class="lsec" style="margin-top:14px">New</p>
      <ul class="t-soft" style="list-style:none;padding:0;margin:0">${added}</ul>

      <p class="lsec" style="margin-top:14px">Already approved</p>
      <ul class="t-soft" style="list-style:none;padding:0;margin:0">${kept}</ul>

      <div class="actions" style="margin-top:18px">
        <button class="btn btn--primary" type="button">Continue</button>
        <button class="btn btn--outline" type="button">Not now</button>
      </div>
      <p class="caution">Choosing "Not now" keeps everything you have already approved.</p>
    `,
  });
}

/** The failure that survives every option: genuinely unrecoverable. */
export function renderUnrecoverable(): string {
  return renderAuthLayout({
    title: "Sign-in couldn't start",
    centered: true,
    bodyHtml: `
      ${confirmIcon("alert")}
      <h1 class="title">Sign-in couldn't start</h1>
      <p class="sub" role="alert">We couldn't recognise the app that sent you here, so nothing was shared. Opening it again usually clears this.</p>
    `,
  });
}
