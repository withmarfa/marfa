/**
 * Auth + email preview gallery — a dev-only tool, never deployed.
 *
 * Boots a tiny standalone server (no database, no app wiring) that renders the
 * real auth page renderers + the real transactional email templates, and serves
 * the real `/auth/static/*` assets, so you can eyeball every screen and state in
 * light, dark, and system without standing up the full server or clicking
 * through flows. Run with:
 *
 *   pnpm --filter @withmarfa/server auth:gallery
 *
 * Then open the printed URL. A top-center tab control switches between the Auth
 * pages and the Email templates. The left sidebar lists the screens for the
 * active tab; the right sidebar lists the states of the selected screen; the
 * center shows the selected state in an iframe. A sun / monitor / moon control
 * forces light, follows the OS, or forces dark — for both the shell chrome and
 * the previewed page.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { AUTH_CSS } from "../src/routes/auth-static/auth-css.js";
import { PASSKEY_JS } from "../src/routes/auth-static/passkey-js.js";
import { PASSWORD_TOGGLE_JS } from "../src/routes/auth-static/password-toggle-js.js";
import { SUBMIT_STATE_JS } from "../src/routes/auth-static/submit-state-js.js";
import { TABS, resolveVariant } from "./auth-gallery-fixtures.js";

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

type PreviewTheme = "light" | "dark" | "system";

function parseTheme(raw: string | undefined): PreviewTheme {
  if (raw === "dark") return "dark";
  if (raw === "light") return "light";
  // Anything else (including the absent param and an explicit `system`) lets
  // the page's own `prefers-color-scheme` rules apply.
  return "system";
}

/**
 * Force the requested theme on the document and intercept form submits so a
 * click demonstrates the loading state (button disables + label swap) without
 * navigating away from the preview.
 *
 * `system` deliberately sets no `data-theme`: the auth CSS already carries a
 * `prefers-color-scheme` block, so leaving the attribute off lets the OS
 * setting drive the page exactly as it would in production.
 */
function decorate(html: string, theme: PreviewTheme): string {
  const themed =
    theme === "system"
      ? html
      : html.replace(
          /<html lang="en">/,
          `<html lang="en" data-theme="${theme}">`,
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
  const tab = c.req.query("tab") ?? "";
  const screen = c.req.query("screen") ?? "";
  const variant = c.req.query("variant") ?? "";
  const theme = parseTheme(c.req.query("theme"));
  const resolved = resolveVariant(tab, screen, variant);
  if (!resolved) {
    return c.text(
      `Unknown tab/screen/variant: ${tab}/${screen}/${variant}`,
      404,
    );
  }
  return c.html(decorate(resolved.variant.render(), theme));
});

app.get("/", (c) => c.html(renderShell()));

/**
 * The gallery shell: a top-center tab control, a left sidebar of screens, an
 * iframe, and a right sidebar of states, plus a theme control.
 */
function renderShell(): string {
  const firstTab = TABS[0];
  const firstScreen = firstTab?.screens[0];
  const firstVariant = firstScreen?.variants[0];
  const initialTab = firstTab?.id ?? "";
  const initialScreen = firstScreen?.id ?? "";
  const initialVariant = firstVariant?.id ?? "";

  // The full tab → screens → variants tree, handed to the client so it can
  // rebuild both sidebars when the tab or screen changes without a round-trip.
  const tabData = TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    screens: tab.screens.map((screen) => ({
      id: screen.id,
      label: screen.label,
      variants: screen.variants.map((v) => ({ id: v.id, label: v.label })),
    })),
  }));

  const tabControl = TABS.map(
    (tab) =>
      `<button class="tab" data-tab="${tab.id}" type="button"><span>${tab.label}</span></button>`,
  ).join("");

  // sun / monitor / moon — Lucide glyphs at the same stroke weight as the
  // password-toggle eye icons, sized down for the compact control.
  const SUN = svgIcon(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  );
  const MONITOR = svgIcon(
    '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  );
  const MOON = svgIcon('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>');

  // The shell styling is plain inline CSS — it's dev chrome, not part of the
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
      color-scheme: light;
    }
    html.dark {
      --page: #0a0a0a;
      --fg: #fafafa;
      --muted: #a1a1aa;
      --hover: #1d1d20;
      --accent: #27272a;
      --accent-fg: #fafafa;
      color-scheme: dark;
    }
    /* System theme: when no theme is forced, follow the OS so the shell tracks
       the preview. Mirrors the html.dark block above, keyed on the media query
       instead of the class. */
    @media (prefers-color-scheme: dark) {
      html.theme-system {
        --page: #0a0a0a;
        --fg: #fafafa;
        --muted: #a1a1aa;
        --hover: #1d1d20;
        --accent: #27272a;
        --accent-fg: #fafafa;
        color-scheme: dark;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      display: grid;
      grid-template-columns: 220px 1fr 220px;
      height: 100vh;
      color: var(--fg);
      background: var(--page);
    }
    /* Both sidebars: no border, no chrome — they blend into the soft-grey page
       like the shadcn docs nav. The nav scrolls between generous top/bottom
       padding with a soft fade at both edges. */
    .sidebar {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    .nav {
      flex: 1;
      overflow-y: auto;
      padding: 120px 14px;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 120px, #000 calc(100% - 120px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 120px, #000 calc(100% - 120px), transparent 100%);
      scrollbar-width: none;
    }
    .nav::-webkit-scrollbar { display: none; }
    .nav--right { text-align: right; }
    .nav-list { list-style: none; margin: 0; padding: 0; }
    /* Full-width click target, but the pill hugs the label (shadcn w-fit). */
    .nav-item {
      display: block;
      width: 100%;
      text-align: inherit;
      border: none;
      background: none;
      padding: 1px 0;
      cursor: pointer;
      font: inherit;
    }
    .nav-item > span {
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
    .nav-item:hover > span { background: var(--hover); }
    .nav-item.active > span { background: var(--accent); color: var(--accent-fg); }
    .stage { position: relative; min-width: 0; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
    /* Top-center tab control: same no-border accent-pill style as the sidebar
       selection, not a bordered segmented control. */
    .tabs {
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 5;
      display: inline-flex;
      gap: 2px;
    }
    .tab {
      border: none;
      background: none;
      padding: 0;
      cursor: pointer;
      font: inherit;
    }
    .tab > span {
      display: inline-flex;
      align-items: center;
      padding: 5px 14px;
      border-radius: 7px;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
    }
    .tab:hover > span { background: var(--hover); }
    .tab.active > span { background: var(--accent); color: var(--accent-fg); }
    /* Theme control, top-right: three icon buttons, same accent-pill style. */
    .theme {
      position: absolute;
      top: 16px;
      right: 16px;
      z-index: 5;
      display: inline-flex;
      gap: 2px;
    }
    .theme button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: none;
      padding: 6px;
      border-radius: 7px;
      color: var(--muted);
      cursor: pointer;
    }
    .theme button:hover { background: var(--hover); }
    .theme button.active { background: var(--accent); color: var(--accent-fg); }
    .theme svg { display: block; width: 16px; height: 16px; }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="nav"><ul class="nav-list" id="screens"></ul></div>
  </nav>
  <main class="stage">
    <div class="tabs" role="group" aria-label="Section">${tabControl}</div>
    <div class="theme" role="group" aria-label="Theme">
      <button id="theme-light" type="button" title="Light" aria-label="Light">${SUN}</button>
      <button id="theme-system" type="button" title="System" aria-label="System">${MONITOR}</button>
      <button id="theme-dark" type="button" title="Dark" aria-label="Dark">${MOON}</button>
    </div>
    <iframe id="preview" title="Preview"></iframe>
  </main>
  <nav class="sidebar">
    <div class="nav nav--right"><ul class="nav-list" id="states"></ul></div>
  </nav>
  <script>
    (function () {
      var TABS = ${JSON.stringify(tabData)};
      // System is the default theme: follow the OS for both shell and preview.
      var state = {
        tab: ${JSON.stringify(initialTab)},
        screen: ${JSON.stringify(initialScreen)},
        variant: ${JSON.stringify(initialVariant)},
        theme: 'system',
      };

      var frame = document.getElementById('preview');
      var screensList = document.getElementById('screens');
      var statesList = document.getElementById('states');
      var themeBtns = {
        light: document.getElementById('theme-light'),
        system: document.getElementById('theme-system'),
        dark: document.getElementById('theme-dark'),
      };

      function currentTab() {
        return TABS.filter(function (t) { return t.id === state.tab; })[0] || TABS[0];
      }
      function currentScreen() {
        var tab = currentTab();
        return tab.screens.filter(function (s) { return s.id === state.screen; })[0] || tab.screens[0];
      }

      function buildItem(label, kind, screenId, variantId) {
        var li = document.createElement('li');
        var btn = document.createElement('button');
        btn.className = 'nav-item';
        btn.type = 'button';
        btn.setAttribute('data-kind', kind);
        btn.setAttribute('data-screen', screenId);
        if (variantId) btn.setAttribute('data-variant', variantId);
        var span = document.createElement('span');
        span.textContent = label;
        btn.appendChild(span);
        li.appendChild(btn);
        return li;
      }

      function renderScreens() {
        screensList.innerHTML = '';
        currentTab().screens.forEach(function (s) {
          screensList.appendChild(buildItem(s.label, 'screen', s.id, null));
        });
      }

      function renderStates() {
        statesList.innerHTML = '';
        currentScreen().variants.forEach(function (v) {
          statesList.appendChild(buildItem(v.label, 'state', state.screen, v.id));
        });
      }

      function markActive() {
        var all = document.querySelectorAll('.nav-item, .tab');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
        var screenBtn = screensList.querySelector('.nav-item[data-screen="' + state.screen + '"]');
        if (screenBtn) screenBtn.classList.add('active');
        var stateBtn = statesList.querySelector('.nav-item[data-variant="' + state.variant + '"]');
        if (stateBtn) stateBtn.classList.add('active');
        var tabBtn = document.querySelector('.tab[data-tab="' + state.tab + '"]');
        if (tabBtn) tabBtn.classList.add('active');
        for (var key in themeBtns) {
          if (themeBtns.hasOwnProperty(key)) {
            themeBtns[key].classList.toggle('active', state.theme === key);
          }
        }
      }

      function applyShellTheme() {
        var el = document.documentElement;
        el.classList.toggle('dark', state.theme === 'dark');
        el.classList.toggle('theme-system', state.theme === 'system');
      }

      function loadPreview() {
        frame.src =
          '/preview?tab=' + encodeURIComponent(state.tab) +
          '&screen=' + encodeURIComponent(state.screen) +
          '&variant=' + encodeURIComponent(state.variant) +
          '&theme=' + state.theme;
      }

      function refresh(opts) {
        opts = opts || {};
        if (opts.rebuildScreens) renderScreens();
        if (opts.rebuildStates || opts.rebuildScreens) renderStates();
        applyShellTheme();
        markActive();
        loadPreview();
      }

      function selectTab(tabId) {
        if (state.tab === tabId) return;
        state.tab = tabId;
        var tab = currentTab();
        state.screen = tab.screens[0].id;
        state.variant = tab.screens[0].variants[0].id;
        refresh({ rebuildScreens: true });
      }

      function selectScreen(screenId) {
        state.screen = screenId;
        state.variant = currentScreen().variants[0].id;
        refresh({ rebuildStates: true });
      }

      function selectVariant(variantId) {
        state.variant = variantId;
        refresh();
      }

      document.querySelectorAll('.tab').forEach(function (b) {
        b.addEventListener('click', function () { selectTab(b.getAttribute('data-tab')); });
      });
      screensList.addEventListener('click', function (e) {
        var btn = e.target.closest('.nav-item');
        if (btn) selectScreen(btn.getAttribute('data-screen'));
      });
      statesList.addEventListener('click', function (e) {
        var btn = e.target.closest('.nav-item');
        if (btn) selectVariant(btn.getAttribute('data-variant'));
      });
      Object.keys(themeBtns).forEach(function (key) {
        themeBtns[key].addEventListener('click', function () {
          state.theme = key;
          applyShellTheme();
          markActive();
          loadPreview();
        });
      });

      refresh({ rebuildScreens: true });
    })();
  </script>
</body>
</html>`;
}

/** Wrap Lucide path data in an SVG matching the password-toggle eye weight. */
function svgIcon(paths: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

const port = Number(process.env.PORT ?? 8650);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`Auth gallery running at http://127.0.0.1:${String(info.port)}`);
});
