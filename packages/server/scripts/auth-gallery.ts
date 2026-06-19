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
 * the previewed page. A view control frames the iframe as freeform (edge to
 * edge), a browser window, or a phone, so the page's own responsive CSS can be
 * checked at each width without changing what it renders.
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
function decorate(html: string, theme: PreviewTheme, isEmail: boolean): string {
  let out =
    theme === "system"
      ? html
      : html.replace(
          /<html lang="en">/,
          `<html lang="en" data-theme="${theme}">`,
        );
  // Emails render top-aligned (correct in a real inbox). In the preview we want
  // them centered vertically like the auth pages, with less canvas top padding.
  if (isEmail) {
    const center =
      "<style>html{height:100%}" +
      "body.m-canvas{min-height:100vh;display:flex;flex-direction:column;justify-content:center}" +
      "table.m-canvas{padding-top:16px !important;padding-bottom:16px !important}</style>";
    out = out.includes("</head>")
      ? out.replace("</head>", `${center}</head>`)
      : center + out;
  }
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
  return out.includes("</body>")
    ? out.replace("</body>", `${interceptor}</body>`)
    : out + interceptor;
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
  const isEmail = tab === "email";
  return c.html(decorate(resolved.variant.render(), theme, isEmail));
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

  // Chevron-down for the text view trigger (Lucide chevron-down), same stroke
  // weight as the theme icons above.
  const CHEVRON_DOWN = svgIcon('<path d="m6 9 6 6 6-6"/>');

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
      --card: #ffffff;
      color-scheme: light;
    }
    html.dark {
      --page: #0a0a0a;
      --fg: #fafafa;
      --muted: #a1a1aa;
      --hover: #1d1d20;
      --accent: #27272a;
      --accent-fg: #fafafa;
      --card: #1a1a1a;
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
        --card: #1a1a1a;
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
      padding: 12px 14px 0;
    }
    /* A fixed-height bar holds each side's top controls (tabs left, theme + view
       right) so the equal margin-top on the headers below lands them on the
       same horizontal line regardless of the controls' own heights. */
    .topbar { flex: none; height: 30px; display: flex; align-items: center; }
    .sidebar--right .topbar { justify-content: flex-end; gap: 4px; }
    .nav-header { flex: none; padding: 0 10px 6px; margin-top: 120px; }
    .nav-header__title { font-size: 12px; font-weight: 500; color: var(--muted); }
    .sidebar--right .nav-header { text-align: right; }
    .nav {
      flex: 1;
      overflow-y: auto;
      padding: 6px 0 40px;
      scrollbar-width: none;
    }
    .nav::-webkit-scrollbar { display: none; }
    .nav--right { text-align: right; }
    .nav--right .nav-item > span { font-weight: 400; }
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
    .stage {
      position: relative;
      min-width: 0;
      overflow: hidden;
      display: grid;
      place-items: center;
    }
    /* The viewport wraps the iframe so the surrounding frame (browser window /
       phone) can be sized and styled without touching the iframe src. The
       freeform default fills the stage edge to edge. */
    .viewport { width: 100%; height: 100%; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
    /* The chrome bar (browser dots + address pill) only shows in the browser
       view; mobile has no browser chrome. */
    .chrome { display: none; }
    /* Browser view: a Safari-style window that fills the stage responsively, so
       the preview never crops or overflows. The stage adds a small inset and the
       window fills the rest. Borders only — no shadow. */
    .stage.view-browser { padding: 22px; }
    .stage.view-browser .viewport {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--card);
      border: 0.5px solid var(--accent);
      border-radius: 12px;
      overflow: hidden;
    }
    .stage.view-browser .chrome {
      position: relative;
      flex: none;
      height: 38px;
      display: flex;
      align-items: center;
      padding: 0 14px;
      border-bottom: 0.5px solid var(--accent);
    }
    /* Three traffic-light dots, pinned left. */
    .stage.view-browser .chrome .dots { display: inline-flex; gap: 7px; }
    .stage.view-browser .chrome .dots i {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--muted);
      opacity: 0.45;
    }
    /* Centered rounded address pill reading the host. */
    .stage.view-browser .chrome .addr {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 180px;
      max-width: 60%;
      height: 22px;
      padding: 0 12px;
      border-radius: 7px;
      background: var(--hover);
      font-size: 12px;
      color: var(--muted);
    }
    .stage.view-browser .viewport iframe { flex: 1; height: auto; }
    /* Mobile view: a plain bordered viewport at a realistic phone size — no
       device bezel, no status bar, no home indicator. The auth page's own mobile
       CSS top-aligns the card. Borders only — no shadow. */
    .stage.view-mobile .viewport {
      width: 390px;
      max-width: calc(100% - 24px);
      height: min(844px, calc(100% - 24px));
      background: var(--page);
      border: 0.5px solid var(--accent);
      border-radius: 12px;
      overflow: hidden;
    }
    .stage.view-mobile .viewport iframe { border-radius: 12px; }
    /* Top-center tab control: same no-border accent-pill style as the sidebar
       selection, not a bordered segmented control. */
    .tabs {
      display: inline-flex;
      gap: 2px;
      flex: none;
      margin: 0 0 0 4px;
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
      display: inline-flex;
      align-self: flex-end;
      flex: none;
      margin: 0 4px 0 0;
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
    /* View control: a borderless text trigger (current mode's label + a small
       chevron) that toggles a popover menu of frame modes. Same family as the
       tabs — no border, no background, subtle hover. */
    .view { position: relative; display: inline-flex; flex: none; }
    .view__button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: none;
      background: none;
      padding: 5px 8px;
      border-radius: 7px;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
      cursor: pointer;
    }
    .view__button:hover { background: var(--hover); }
    .view__button svg { display: block; width: 14px; height: 14px; }
    /* Menu separates from the page with a border, not a shadow. */
    .view__menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 10;
      display: none;
      flex-direction: column;
      gap: 2px;
      min-width: 140px;
      padding: 5px;
      border: 0.5px solid var(--accent);
      border-radius: 10px;
      background: var(--card);
    }
    .view.open .view__menu { display: flex; }
    .view__option {
      display: block;
      width: 100%;
      border: none;
      background: none;
      padding: 7px 10px;
      border-radius: 7px;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      text-align: left;
      color: var(--fg);
      cursor: pointer;
    }
    .view__option:hover { background: var(--hover); }
    .view__option.active { background: var(--accent); color: var(--accent-fg); }
  </style>
</head>
<body>
  <nav class="sidebar sidebar--left">
    <div class="topbar">
      <div class="tabs" role="group" aria-label="Section">${tabControl}</div>
    </div>
    <div class="nav-header">
      <div class="nav-header__title">Screen</div>
    </div>
    <div class="nav"><ul class="nav-list" id="screens"></ul></div>
  </nav>
  <main class="stage" id="stage">
    <div class="viewport">
      <div class="chrome" aria-hidden="true">
        <span class="dots"><i></i><i></i><i></i></span>
        <span class="addr">marfa.so</span>
      </div>
      <iframe id="preview" title="Preview"></iframe>
    </div>
  </main>
  <nav class="sidebar sidebar--right">
    <div class="topbar">
      <div class="view" id="view">
        <button id="view-button" class="view__button" type="button" aria-label="Change view" aria-haspopup="true" aria-expanded="false"><span id="view-label"></span>${CHEVRON_DOWN}</button>
        <div class="view__menu" id="view-menu" role="menu"></div>
      </div>
      <div class="theme">
        <button id="theme-cycle" type="button" aria-label="Toggle theme">${MONITOR}</button>
      </div>
    </div>
    <div class="nav-header">
      <div class="nav-header__title">State</div>
    </div>
    <div class="nav nav--right"><ul class="nav-list" id="states"></ul></div>
  </nav>
  <script>
    (function () {
      var TABS = ${JSON.stringify(tabData)};
      // System is the default theme; freeform is the default view (iframe fills
      // the stage edge to edge).
      var state = {
        tab: ${JSON.stringify(initialTab)},
        screen: ${JSON.stringify(initialScreen)},
        variant: ${JSON.stringify(initialVariant)},
        theme: 'system',
        view: 'freeform',
      };

      var frame = document.getElementById('preview');
      var screensList = document.getElementById('screens');
      var statesList = document.getElementById('states');
      var themeCycleBtn = document.getElementById('theme-cycle');
      var stage = document.getElementById('stage');
      var viewWrap = document.getElementById('view');
      var viewButton = document.getElementById('view-button');
      var viewLabel = document.getElementById('view-label');
      var viewMenu = document.getElementById('view-menu');
      var THEME_ORDER = ['light', 'system', 'dark'];
      var THEME_ICONS = {
        light: ${JSON.stringify(SUN)},
        system: ${JSON.stringify(MONITOR)},
        dark: ${JSON.stringify(MOON)},
      };
      var VIEW_OPTIONS = [
        { id: 'freeform', label: 'Freeform' },
        { id: 'browser', label: 'Browser' },
        { id: 'mobile', label: 'Mobile' },
      ];
      function viewLabelFor(id) {
        for (var i = 0; i < VIEW_OPTIONS.length; i++) {
          if (VIEW_OPTIONS[i].id === id) return VIEW_OPTIONS[i].label;
        }
        return VIEW_OPTIONS[0].label;
      }

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
        themeCycleBtn.innerHTML = THEME_ICONS[state.theme];
        themeCycleBtn.title =
          state.theme === 'system' ? 'System appearance'
          : state.theme === 'dark' ? 'Dark'
          : 'Light';
      }

      function applyShellTheme() {
        var el = document.documentElement;
        el.classList.toggle('dark', state.theme === 'dark');
        el.classList.toggle('theme-system', state.theme === 'system');
      }

      function applyView() {
        // Only the surrounding frame changes; the iframe src is untouched, so
        // the page inside responds purely to its new width.
        stage.classList.toggle('view-browser', state.view === 'browser');
        stage.classList.toggle('view-mobile', state.view === 'mobile');
        viewLabel.textContent = viewLabelFor(state.view);
        var options = viewMenu.querySelectorAll('.view__option');
        for (var i = 0; i < options.length; i++) {
          var id = options[i].getAttribute('data-view');
          options[i].classList.toggle('active', id === state.view);
        }
      }

      function renderViewMenu() {
        viewMenu.innerHTML = '';
        VIEW_OPTIONS.forEach(function (opt) {
          var btn = document.createElement('button');
          btn.className = 'view__option';
          btn.type = 'button';
          btn.setAttribute('role', 'menuitem');
          btn.setAttribute('data-view', opt.id);
          btn.textContent = opt.label;
          viewMenu.appendChild(btn);
        });
      }

      function closeViewMenu() {
        viewWrap.classList.remove('open');
        viewButton.setAttribute('aria-expanded', 'false');
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
        applyView();
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
      themeCycleBtn.addEventListener('click', function () {
        var i = THEME_ORDER.indexOf(state.theme);
        state.theme = THEME_ORDER[(i + 1) % THEME_ORDER.length];
        applyShellTheme();
        markActive();
        loadPreview();
      });

      viewButton.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !viewWrap.classList.contains('open');
        viewWrap.classList.toggle('open', open);
        viewButton.setAttribute('aria-expanded', String(open));
      });
      viewMenu.addEventListener('click', function (e) {
        var btn = e.target.closest('.view__option');
        if (!btn) return;
        // The frame change is preview-only; no iframe reload, so don't refresh().
        state.view = btn.getAttribute('data-view');
        applyView();
        closeViewMenu();
      });
      // Any click outside the open menu closes it.
      document.addEventListener('click', function (e) {
        if (viewWrap.classList.contains('open') && !viewWrap.contains(e.target)) {
          closeViewMenu();
        }
      });

      renderViewMenu();
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
