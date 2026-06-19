/**
 * Auth-page preview gallery — a dev-only tool, never deployed.
 *
 * Boots a tiny standalone server (no database, no app wiring) that renders the
 * real auth page renderers + serves the real `/auth/static/*` assets, so you
 * can eyeball every screen and state in light and dark without standing up the
 * full server or clicking through flows. Run with:
 *
 *   pnpm --filter @withmarfa/server auth:gallery
 *
 * Then open the printed URL. The left sidebar lists every screen grouped with
 * its state variants; the main area shows the selected variant in an iframe; a
 * light/dark toggle re-points the iframe with a `theme` param so the
 * forced-theme CSS applies regardless of the OS setting.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { AUTH_CSS } from "../src/routes/auth-static/auth-css.js";
import { PASSKEY_JS } from "../src/routes/auth-static/passkey-js.js";
import { PASSWORD_TOGGLE_JS } from "../src/routes/auth-static/password-toggle-js.js";
import { SUBMIT_STATE_JS } from "../src/routes/auth-static/submit-state-js.js";
import { SCREENS, resolveVariant } from "./auth-gallery-fixtures.js";

const app = new Hono();

const JS_HEADERS = { "Content-Type": "application/javascript; charset=utf-8" };

// Serve the real static assets so the previewed iframes load exactly what
// ships, not a re-implementation.
app.get("/auth/static/auth.css", (c) =>
  c.body(AUTH_CSS, 200, { "Content-Type": "text/css; charset=utf-8" }),
);
app.get("/auth/static/passkey.js", (c) => c.body(PASSKEY_JS, 200, JS_HEADERS));
app.get("/auth/static/password-toggle.js", (c) =>
  c.body(PASSWORD_TOGGLE_JS, 200, JS_HEADERS),
);
app.get("/auth/static/submit-state.js", (c) =>
  c.body(SUBMIT_STATE_JS, 200, JS_HEADERS),
);

/**
 * Force the requested theme on the document and intercept form submits so a
 * click demonstrates the loading state (button disables + label swap) without
 * navigating away from the preview.
 */
function decorate(html: string, theme: "light" | "dark"): string {
  const themed = html.replace(
    /<html lang="en">/,
    `<html lang="en" data-theme="${theme === "dark" ? "dark" : "light"}">`,
  );
  const interceptor = `
<script>
  // Preview-only: stop POST navigations so the submitting state is visible.
  // GET forms (the one-time-link switch) stay live so view switches still work.
  document.addEventListener('submit', function (e) {
    var method = (e.target.getAttribute('method') || 'get').toLowerCase();
    if (method === 'post') e.preventDefault();
  }, true);
</script>
`;
  return themed.includes("</body>")
    ? themed.replace("</body>", `${interceptor}</body>`)
    : themed + interceptor;
}

app.get("/preview", (c) => {
  const screen = c.req.query("screen") ?? "";
  const variant = c.req.query("variant") ?? "";
  const theme = c.req.query("theme") === "dark" ? "dark" : "light";
  const resolved = resolveVariant(screen, variant);
  if (!resolved) {
    return c.text(`Unknown screen/variant: ${screen}/${variant}`, 404);
  }
  return c.html(decorate(resolved.variant.render(), theme));
});

app.get("/", (c) => c.html(renderShell()));

/** The gallery shell: sidebar of screens + variants, an iframe, a theme toggle. */
function renderShell(): string {
  const firstScreen = SCREENS[0];
  const firstVariant = firstScreen?.variants[0];
  const initialScreen = firstScreen?.id ?? "";
  const initialVariant = firstVariant?.id ?? "";

  const sidebar = SCREENS.map((screen) => {
    const items = screen.variants
      .map(
        (v) =>
          `<li><button class="variant" data-screen="${screen.id}" data-variant="${v.id}"><span>${v.label}</span></button></li>`,
      )
      .join("");
    return `<div class="group">
      <div class="group__label">${screen.label}</div>
      <ul class="variants">${items}</ul>
    </div>`;
  }).join("");

  // The shell styling is plain inline CSS — it's a dev chrome, not part of the
  // auth surface, so it deliberately doesn't share AUTH_CSS.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Marfa auth gallery</title>
  <style>
    :root {
      --page: #f5f5f5;
      --fg: #18181b;
      --muted: #71717a;
      --hover: #ececef;
      --accent: #e6e6ea;
      --accent-fg: #18181b;
      --toggle-bg: #ffffff;
      --toggle-border: #e4e4e7;
      --toggle-active: #ededf0;
      color-scheme: light;
    }
    html.dark {
      --page: #0a0a0a;
      --fg: #fafafa;
      --muted: #a1a1aa;
      --hover: #1d1d20;
      --accent: #27272a;
      --accent-fg: #fafafa;
      --toggle-bg: #18181b;
      --toggle-border: #2a2a2e;
      --toggle-active: #303036;
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      display: grid;
      grid-template-columns: 248px 1fr;
      height: 100vh;
      color: var(--fg);
      background: var(--page);
    }
    /* Sidebar: no border, no chrome — blends into the soft-grey page like the
       shadcn docs nav. Brand pinned, nav scrolls under a bottom fade. */
    .sidebar {
      display: flex;
      flex-direction: column;
      padding: 22px 14px 0;
      min-height: 0;
    }
    .brand {
      flex: none;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--muted);
      padding: 0 10px 14px;
    }
    .nav {
      flex: 1;
      overflow-y: auto;
      padding-bottom: 48px;
      -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 44px), transparent 100%);
      mask-image: linear-gradient(to bottom, #000 calc(100% - 44px), transparent 100%);
      scrollbar-width: none;
    }
    .nav::-webkit-scrollbar { display: none; }
    .group { margin-bottom: 18px; }
    .group__label {
      font-size: 12px;
      font-weight: 500;
      color: var(--muted);
      padding: 0 10px 4px;
    }
    .variants { list-style: none; margin: 0; padding: 0; }
    /* Full-width click target, but the pill hugs the label (shadcn w-fit). */
    .variant {
      display: block;
      width: 100%;
      text-align: left;
      border: none;
      background: none;
      padding: 1px 0;
      cursor: pointer;
      font: inherit;
    }
    .variant > span {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5px 10px;
      border-radius: 7px;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.2;
      color: var(--fg);
    }
    .variant:hover > span { background: var(--hover); }
    .variant.active > span { background: var(--accent); color: var(--accent-fg); }
    .stage { position: relative; min-width: 0; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
    /* Floating theme toggle, top-right, over the preview. No nav bar. */
    .theme {
      position: absolute;
      top: 16px;
      right: 16px;
      z-index: 5;
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      background: var(--toggle-bg);
      border: 1px solid var(--toggle-border);
      border-radius: 999px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    }
    .theme button {
      border: none;
      background: none;
      padding: 4px 13px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 999px;
      color: var(--muted);
      cursor: pointer;
    }
    .theme button.active { background: var(--toggle-active); color: var(--fg); }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="brand">Marfa auth</div>
    <div class="nav">${sidebar}</div>
  </nav>
  <main class="stage">
    <div class="theme" role="group" aria-label="Theme">
      <button id="theme-light" class="active" type="button">Light</button>
      <button id="theme-dark" type="button">Dark</button>
    </div>
    <iframe id="preview" title="Auth page preview"></iframe>
  </main>
  <script>
    (function () {
      var state = { screen: ${JSON.stringify(initialScreen)}, variant: ${JSON.stringify(initialVariant)}, theme: 'light' };
      var frame = document.getElementById('preview');
      var lightBtn = document.getElementById('theme-light');
      var darkBtn = document.getElementById('theme-dark');

      function refresh() {
        frame.src =
          '/preview?screen=' + encodeURIComponent(state.screen) +
          '&variant=' + encodeURIComponent(state.variant) +
          '&theme=' + state.theme;
        var active = document.querySelector('.variant.active');
        if (active) active.classList.remove('active');
        var btn = document.querySelector(
          '.variant[data-screen="' + state.screen + '"][data-variant="' + state.variant + '"]'
        );
        if (btn) btn.classList.add('active');
        document.documentElement.classList.toggle('dark', state.theme === 'dark');
        lightBtn.classList.toggle('active', state.theme === 'light');
        darkBtn.classList.toggle('active', state.theme === 'dark');
      }

      document.querySelectorAll('.variant').forEach(function (b) {
        b.addEventListener('click', function () {
          state.screen = b.getAttribute('data-screen');
          state.variant = b.getAttribute('data-variant');
          refresh();
        });
      });
      lightBtn.addEventListener('click', function () { state.theme = 'light'; refresh(); });
      darkBtn.addEventListener('click', function () { state.theme = 'dark'; refresh(); });

      refresh();
    })();
  </script>
</body>
</html>`;
}

const port = Number(process.env.PORT ?? 8650);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`Auth gallery running at http://127.0.0.1:${String(info.port)}`);
});
