/**
 * Marfa UI Viewer, a development tool that is never deployed.
 *
 * Boots a small standalone server, with no database and no app wiring, that
 * renders the real page renderers with example values and serves the real
 * page stylesheet and script, so every screen and state can be seen in light
 * and dark without standing up the server or clicking through flows:
 *
 *   pnpm --filter @withmarfa/server ui:viewer
 *
 * The tab control switches between the getting-in pages and the console. The
 * left sidebar lists the screens of the tab, the right sidebar the states of
 * the screen, and the center shows the state in an iframe, framed as
 * freeform, a browser window or a phone. Arrow keys step the screen (up and
 * down) and the state (left and right); A toggles the tab, V cycles the view,
 * T cycles the appearance, and the keyboard button lists the shortcuts.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PAGE_ASSETS } from "../src/pages/assets.js";
import { TABS, resolveVariant } from "./ui-viewer-fixtures.js";

const app = new Hono();

type PreviewTheme = "light" | "dark" | "system";

function parseTheme(raw: string | undefined): PreviewTheme {
  if (raw === "dark") return "dark";
  if (raw === "light") return "light";
  return "system";
}

/**
 * The pages follow `prefers-color-scheme` and have no theme switch, and a
 * frame cannot set that preference for the document inside it. So a forced
 * theme is served as the stylesheet with its dark block always or never on.
 */
const DARK_BLOCK = /@media\s*\(prefers-color-scheme:\s*dark\)/g;

function stylesheet(theme: PreviewTheme): string {
  const css = PAGE_ASSETS["pages.css"].body;
  if (theme === "system") return css;
  return css.replace(
    DARK_BLOCK,
    theme === "dark" ? "@media all" : "@media not all",
  );
}

app.get("/auth/static/pages.css", (c) =>
  c.body(stylesheet(parseTheme(c.req.query("theme"))), 200, {
    "Content-Type": PAGE_ASSETS["pages.css"].contentType,
  }),
);
app.get("/auth/static/pages.js", (c) =>
  c.body(PAGE_ASSETS["pages.js"].body, 200, {
    "Content-Type": PAGE_ASSETS["pages.js"].contentType,
  }),
);

/**
 * Points the page at the stylesheet for the chosen theme, and stops POST
 * forms from navigating, so a click shows the page's submitting state without
 * leaving the preview.
 */
function decorate(html: string, theme: PreviewTheme): string {
  const out = html.replace(
    "/auth/static/pages.css?",
    `/auth/static/pages.css?theme=${theme}&amp;`,
  );
  const interceptor = `
<script>
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
      designVariants: (screen.designVariants ?? []).map((v) => ({
        id: v.id,
        label: v.label,
      })),
    })),
  }));

  // Sun, monitor and moon: Lucide glyphs, sized down for the compact control.
  const SUN = svgIcon(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  );
  const MONITOR = svgIcon(
    '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  );
  const MOON = svgIcon('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>');

  // Chevron-down for the text view + section triggers (Lucide chevron-down),
  // same stroke weight as the theme icons above.
  const CHEVRON_DOWN = svgIcon('<path d="m6 9 6 6 6-6"/>');

  // Lucide keyboard glyph for the bottom-right shortcuts button.
  const KEYBOARD = svgIcon(
    '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.001"/><path d="M10 8h.001"/><path d="M14 8h.001"/><path d="M18 8h.001"/><path d="M8 12h.001"/><path d="M12 12h.001"/><path d="M16 12h.001"/><path d="M7 16h10"/>',
  );

  // The shell's own styles stay inline: it is a development tool, not a page,
  // and must not change when the page system's styles do.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Marfa UI Viewer</title>
  <style>
    :root {
      --page: #f5f5f5;
      --fg: #18181b;
      --muted: #71717a;
      --hover: #ececef;
      --accent: #e6e6ea;
      --accent-fg: #18181b;
      --card: #ffffff;
      /* The device-frame outline (browser window + phone) — a clear
         dark grey that still reads as a hard edge against the page without being
         pure black. Slightly lighter on the dark page so it stays legible. */
      --frame-border: #52525b;
      /* Context-menu surface + its option states. The menu is frosted glass
         (translucent + backdrop blur), and its hover/selected fills are
         subtler than the sidebar nav so the popover reads as a light overlay,
         not an opaque card. */
      --menu-bg: rgba(255, 255, 255, 0.5);
      --menu-hover: rgba(0, 0, 0, 0.05);
      --menu-accent: rgba(0, 0, 0, 0.08);
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
      --frame-border: #71717a;
      --menu-bg: rgba(26, 26, 26, 0.5);
      --menu-hover: rgba(255, 255, 255, 0.06);
      --menu-accent: rgba(255, 255, 255, 0.1);
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
        --frame-border: #71717a;
        --menu-bg: rgba(26, 26, 26, 0.5);
        --menu-hover: rgba(255, 255, 255, 0.06);
        --menu-accent: rgba(255, 255, 255, 0.1);
        color-scheme: dark;
      }
    }
    * { box-sizing: border-box; }
    /* Suppress the browser's blue focus ring on the gallery shell's own
       controls — this is dev chrome, and the ring fires after every click. The
       previewed page lives in a separate iframe document, so its own focus
       rings are untouched. */
    :focus, :focus-visible { outline: none; }
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
       same horizontal line regardless of the controls' own heights. Every
       interactive control inside a topbar shares --control-h and centers its
       contents, so the tab pill, view trigger, and theme button line up to the
       pixel top and bottom. */
    :root { --control-h: 30px; }
    .topbar { flex: none; height: var(--control-h); display: flex; align-items: center; }
    .sidebar--right .topbar { justify-content: flex-end; gap: 4px; }
    .nav-header { flex: none; padding: 0 10px 6px; margin-top: 120px; }
    .nav-header__title { font-size: 12px; font-weight: 500; color: var(--muted); }
    .sidebar--right .nav-header { text-align: right; }
    /* "Variant" group heading, separating design variants from states in the
       right column. A large gap pushes it well clear of the states list so the
       two groups read as distinct. */
    .nav-subhead {
      margin: 160px 10px 4px;
      font-size: 12px;
      font-weight: 500;
      color: var(--muted);
    }
    .sidebar--right .nav-subhead { text-align: right; }
    .nav {
      flex: 1;
      overflow-y: auto;
      padding: 6px 0 40px;
      scrollbar-width: none;
    }
    .nav::-webkit-scrollbar { display: none; }
    .nav--right { text-align: right; }
    .nav--right .nav-item > span { font-weight: 400; }
    .nav-list { list-style: none; margin: 0; padding: 0; position: relative; }
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
      position: relative;
      z-index: 1;
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
    /* The active pill is drawn by a single .nav-marker that animates between
       items (see the motion control); the active label itself goes transparent
       so the moving marker shows through. */
    .nav-item.active > span { background: transparent; color: var(--accent-fg); }
    .nav-marker {
      position: absolute;
      left: 0; top: 0;
      z-index: 0;
      height: 0;
      background: var(--accent);
      border-radius: 7px;
      will-change: translate, height, scale, opacity;
    }
    /* Motion styles — the same marker, moved different ways. data-motion lives
       on <body>; "none" jumps instantly (no transition). */
    body[data-motion="slide"] .nav-marker {
      transition: translate 0.22s cubic-bezier(0.2, 0.7, 0.2, 1),
                  height 0.22s cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    body[data-motion="spring"] .nav-marker {
      transition: translate 0.36s cubic-bezier(0.34, 1.56, 0.64, 1),
                  height 0.36s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    body[data-motion="trail"] .nav-marker {
      transition: translate 0.28s cubic-bezier(0.34, 1.4, 0.5, 1),
                  height 0.28s cubic-bezier(0.34, 1.4, 0.5, 1),
                  scale 0.26s ease-out;
    }
    body[data-motion="morph"] .nav-marker { transition: opacity 0.16s ease; }
    @media (prefers-reduced-motion: reduce) {
      .nav-marker { transition: none !important; }
    }
    /* Bottom-left motion switcher, mirroring the shortcuts button opposite. */
    .motion { position: fixed; left: 16px; bottom: 16px; z-index: 20; }
    .motion__button {
      border: 0.5px solid var(--accent); background: var(--card); color: var(--muted);
      font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 999px; cursor: pointer;
    }
    .motion__button b { color: var(--fg); font-weight: 500; }
    .motion__button:hover { color: var(--fg); }
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
    /* Browser view: a Safari-style window framed as a realistic 3:2 landscape
       window, centered in the stage. Explicitly fill the larger dimension so the
       window grows to the biggest 3:2 box that fits the stage — without a fill
       width the box collapses to a small intrinsic size and clips the page. The
       width is the lesser of "the stage minus breathing room" and "what a full-
       height 3:2 box would be", so it never crops, overflows, or flips to
       portrait. A hard dark outline makes it stand off the page. Borders only —
       no shadow. */
    .stage.view-browser .viewport {
      aspect-ratio: 3 / 2;
      width: min(calc(100% - 48px), calc((100vh - 48px) * 1.5));
      height: auto;
      max-height: calc(100% - 48px);
      display: flex;
      flex-direction: column;
      background: var(--card);
      border: 1.5px solid var(--frame-border);
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
       device bezel, no status bar, no home indicator. The same hard dark
       outline as the browser frame makes the phone shape read clearly against
       the page (a faint border vanished on the light-grey page). Borders only — no shadow. */
    .stage.view-mobile .viewport {
      width: 390px;
      max-width: calc(100% - 24px);
      height: min(780px, calc(100% - 24px));
      background: var(--page);
      border: 1.5px solid var(--frame-border);
      border-radius: 12px;
      overflow: hidden;
    }
    .stage.view-mobile .viewport iframe { border-radius: 12px; }
    /* Top-left section dropdown: mirrors the view dropdown's interaction, but
       its trigger label is black + slightly heavier — it's the primary selector,
       so it reads as the strong control against the grey view trigger opposite.
       Borderless trigger, popover menu separated by a border (no shadow). */
    .section { position: relative; display: inline-flex; flex: none; margin: 0 0 0 4px; }
    .section__button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: var(--control-h);
      border: none;
      background: none;
      padding: 0 8px;
      border-radius: 7px;
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      color: var(--fg);
      cursor: pointer;
    }
    .section__button:hover { background: var(--hover); }
    .section__button svg { display: block; width: 14px; height: 14px; }
    .section__menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 10;
      display: none;
      flex-direction: column;
      gap: 2px;
      min-width: 140px;
      padding: 5px;
      border: 0.5px solid var(--accent);
      border-radius: 10px;
      background: var(--menu-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .section.open .section__menu { display: flex; }
    .section__option {
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
    .section__option:hover { background: var(--menu-hover); }
    .section__option.active { background: var(--menu-accent); color: var(--accent-fg); }
    /* Theme control, top-right: an icon button, same accent-pill style. The
       topbar centers it; no per-control vertical alignment so it shares the
       view trigger's baseline exactly. */
    .theme {
      display: inline-flex;
      align-items: center;
      flex: none;
      margin: 0 4px 0 0;
    }
    .theme button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: var(--control-h);
      width: var(--control-h);
      border: none;
      background: none;
      padding: 0;
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
      height: var(--control-h);
      border: none;
      background: none;
      padding: 0 8px;
      border-radius: 7px;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
      cursor: pointer;
    }
    .view__button:hover { background: var(--hover); }
    .view__button svg { display: block; width: 14px; height: 14px; }
    /* Menu separates from the page with a border, not a shadow — and the
       frosted-glass surface keeps it legible over the preview behind it. */
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
      background: var(--menu-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
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
    .view__option:hover { background: var(--menu-hover); }
    .view__option.active { background: var(--menu-accent); color: var(--accent-fg); }
    /* Keyboard shortcuts: an icon button pinned to the bottom-right of the
       viewport (same borderless icon-button style as the theme control) whose
       popover opens UPWARD — it sits at the bottom edge. Bordered card, no
       shadow. */
    .shortcuts { position: fixed; right: 16px; bottom: 16px; z-index: 20; }
    .shortcuts__button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: var(--control-h);
      width: var(--control-h);
      border: none;
      background: none;
      padding: 0;
      border-radius: 7px;
      color: var(--muted);
      cursor: pointer;
    }
    .shortcuts__button:hover { background: var(--hover); }
    .shortcuts.open .shortcuts__button { background: var(--accent); color: var(--accent-fg); }
    .shortcuts__button svg { display: block; width: 16px; height: 16px; }
    .shortcuts__menu {
      position: absolute;
      bottom: calc(100% + 6px);
      right: 0;
      display: none;
      flex-direction: column;
      gap: 8px;
      min-width: 240px;
      padding: 12px;
      border: 0.5px solid var(--accent);
      border-radius: 10px;
      background: var(--menu-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .shortcuts.open .shortcuts__menu { display: flex; }
    .shortcuts__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .shortcuts__label { font-size: 13px; color: var(--fg); }
    .shortcuts__keys { display: inline-flex; gap: 4px; flex: none; }
    /* kbd-style chip — bordered rounded box around the arrow glyph. */
    .shortcuts__keys kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 5px;
      border: 0.5px solid var(--accent);
      border-radius: 5px;
      background: var(--card);
      font-family: inherit;
      font-size: 12px;
      color: var(--fg);
    }
  </style>
</head>
<body>
  <nav class="sidebar sidebar--left">
    <div class="topbar">
      <div class="section" id="section">
        <button id="section-button" class="section__button" type="button" aria-label="Change section" aria-haspopup="true" aria-expanded="false"><span id="section-label"></span>${CHEVRON_DOWN}</button>
        <div class="section__menu" id="section-menu" role="menu"></div>
      </div>
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
    <div class="nav nav--right">
      <ul class="nav-list" id="states"></ul>
      <div class="nav-subhead" id="variants-subhead" hidden>Variant</div>
      <ul class="nav-list" id="variants"></ul>
    </div>
  </nav>
  <div class="shortcuts" id="shortcuts">
    <div class="shortcuts__menu" id="shortcuts-menu" role="menu">
      <div class="shortcuts__row">
        <span class="shortcuts__label">Previous / next screen</span>
        <span class="shortcuts__keys"><kbd>&uarr;</kbd><kbd>&darr;</kbd></span>
      </div>
      <div class="shortcuts__row">
        <span class="shortcuts__label">Previous / next state</span>
        <span class="shortcuts__keys"><kbd>&larr;</kbd><kbd>&rarr;</kbd></span>
      </div>
      <div class="shortcuts__row">
        <span class="shortcuts__label">Toggle Getting in / Console</span>
        <span class="shortcuts__keys"><kbd>A</kbd></span>
      </div>
      <div class="shortcuts__row">
        <span class="shortcuts__label">Cycle view</span>
        <span class="shortcuts__keys"><kbd>V</kbd></span>
      </div>
      <div class="shortcuts__row">
        <span class="shortcuts__label">Cycle appearance</span>
        <span class="shortcuts__keys"><kbd>T</kbd></span>
      </div>
      <div class="shortcuts__row">
        <span class="shortcuts__label">Cycle nav motion</span>
        <span class="shortcuts__keys"><kbd>M</kbd></span>
      </div>
    </div>
    <button id="shortcuts-button" class="shortcuts__button" type="button" aria-label="Keyboard shortcuts" aria-haspopup="true" aria-expanded="false">${KEYBOARD}</button>
  </div>
  <div class="motion" id="motion">
    <button id="motion-btn" class="motion__button" type="button" aria-label="Cycle nav motion">Motion · <b id="motion-name">Slide</b></button>
  </div>
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
        motion: 'slide',
      };

      var frame = document.getElementById('preview');
      var screensList = document.getElementById('screens');
      var statesList = document.getElementById('states');
      var variantsList = document.getElementById('variants');
      var variantsSubhead = document.getElementById('variants-subhead');
      var motionBtn = document.getElementById('motion-btn');
      var motionName = document.getElementById('motion-name');
      var MOTION_ORDER = ['none', 'slide', 'spring', 'trail', 'morph'];
      var MOTION_LABELS = { none: 'None', slide: 'Slide', spring: 'Spring', trail: 'Trail', morph: 'Morph' };
      var themeCycleBtn = document.getElementById('theme-cycle');
      var stage = document.getElementById('stage');
      var sectionWrap = document.getElementById('section');
      var sectionButton = document.getElementById('section-button');
      var sectionLabel = document.getElementById('section-label');
      var sectionMenu = document.getElementById('section-menu');
      var viewWrap = document.getElementById('view');
      var viewButton = document.getElementById('view-button');
      var viewLabel = document.getElementById('view-label');
      var viewMenu = document.getElementById('view-menu');
      var shortcutsWrap = document.getElementById('shortcuts');
      var shortcutsButton = document.getElementById('shortcuts-button');
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
      var VIEW_IDS = ['freeform', 'browser', 'mobile'];
      function viewOptionsForTab(tabId) {
        var ids = VIEW_IDS;
        return VIEW_OPTIONS.filter(function (opt) {
          return ids.indexOf(opt.id) !== -1;
        });
      }
      function viewLabelFor(id) {
        for (var i = 0; i < VIEW_OPTIONS.length; i++) {
          if (VIEW_OPTIONS[i].id === id) return VIEW_OPTIONS[i].label;
        }
        return VIEW_OPTIONS[0].label;
      }
      function sectionLabelFor(id) {
        for (var i = 0; i < TABS.length; i++) {
          if (TABS[i].id === id) return TABS[i].label;
        }
        return TABS[0].label;
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

      // Design variants for the current screen, listed under a "Variant"
      // subheading beneath the states. Hidden when the screen has none.
      function renderVariants() {
        variantsList.innerHTML = '';
        var dv = currentScreen().designVariants || [];
        variantsSubhead.hidden = dv.length === 0;
        dv.forEach(function (v) {
          variantsList.appendChild(buildItem(v.label, 'state', state.screen, v.id));
        });
      }

      function markActive() {
        var all = document.querySelectorAll('.nav-item');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
        var screenBtn = screensList.querySelector('.nav-item[data-screen="' + state.screen + '"]');
        if (screenBtn) screenBtn.classList.add('active');
        // The active id lives in the states list or the variants list — both
        // feed the same state.variant, and their ids do not collide.
        var activeBtn = statesList.querySelector('.nav-item[data-variant="' + state.variant + '"]')
          || variantsList.querySelector('.nav-item[data-variant="' + state.variant + '"]');
        if (activeBtn) activeBtn.classList.add('active');
        sectionLabel.textContent = sectionLabelFor(state.tab);
        var sectionOptions = sectionMenu.querySelectorAll('.section__option');
        for (var j = 0; j < sectionOptions.length; j++) {
          var sid = sectionOptions[j].getAttribute('data-tab');
          sectionOptions[j].classList.toggle('active', sid === state.tab);
        }
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

      // ---- Nav active-marker motion ----
      // One pill per list animates between items; the motion style governs how.
      function positionMarker(ul, btn, animate) {
        if (!ul) return;
        var marker = ul.querySelector('.nav-marker');
        if (!btn) { if (marker) marker.style.opacity = '0'; return; }
        if (!marker) {
          marker = document.createElement('div');
          marker.className = 'nav-marker';
          ul.insertBefore(marker, ul.firstChild);
          animate = false; // a freshly (re)built list places without animating in
        }
        marker.style.opacity = '1';
        var span = btn.querySelector('span') || btn;
        var ulRect = ul.getBoundingClientRect();
        var r = span.getBoundingClientRect();
        var x = r.left - ulRect.left;
        var y = r.top - ulRect.top;
        function place() {
          marker.style.width = r.width + 'px';
          marker.style.height = r.height + 'px';
          marker.style.translate = x + 'px ' + y + 'px';
        }
        if (!animate || state.motion === 'none') {
          marker.style.transition = 'none';
          marker.style.scale = '1 1';
          place();
          void marker.offsetWidth; // flush so a later move animates
          marker.style.transition = '';
          return;
        }
        if (state.motion === 'morph') {
          // Fade out at the old spot, jump, fade in at the new one.
          marker.style.opacity = '0';
          requestAnimationFrame(function () {
            var keep = marker.style.transition;
            marker.style.transition = 'none';
            place();
            void marker.offsetWidth;
            marker.style.transition = keep;
            marker.style.opacity = '1';
          });
          return;
        }
        place();
        if (state.motion === 'trail') {
          // Stretch tall mid-flight, then settle to the item height.
          marker.style.scale = '1 1.5';
          clearTimeout(marker._t);
          marker._t = setTimeout(function () { marker.style.scale = '1 1'; }, 70);
        } else {
          marker.style.scale = '1 1';
        }
      }

      function updateMarkers(opts) {
        opts = opts || {};
        positionMarker(
          screensList,
          screensList.querySelector('.nav-item[data-screen="' + state.screen + '"]'),
          !opts.rebuildScreens
        );
        // The active state lives in the states list OR the variants list; place a
        // marker in whichever holds it and hide the other's.
        var stateAnimate = !(opts.rebuildStates || opts.rebuildScreens);
        positionMarker(
          statesList,
          statesList.querySelector('.nav-item[data-variant="' + state.variant + '"]'),
          stateAnimate
        );
        positionMarker(
          variantsList,
          variantsList.querySelector('.nav-item[data-variant="' + state.variant + '"]'),
          stateAnimate
        );
      }

      function applyMotion() {
        document.body.setAttribute('data-motion', state.motion);
        if (motionName) motionName.textContent = MOTION_LABELS[state.motion] || state.motion;
      }

      function cycleMotion() {
        var i = MOTION_ORDER.indexOf(state.motion);
        state.motion = MOTION_ORDER[(i + 1) % MOTION_ORDER.length];
        applyMotion();
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
        viewOptionsForTab(state.tab).forEach(function (opt) {
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

      function renderSectionMenu() {
        sectionMenu.innerHTML = '';
        TABS.forEach(function (tab) {
          var btn = document.createElement('button');
          btn.className = 'section__option';
          btn.type = 'button';
          btn.setAttribute('role', 'menuitem');
          btn.setAttribute('data-tab', tab.id);
          btn.textContent = tab.label;
          sectionMenu.appendChild(btn);
        });
      }

      function closeSectionMenu() {
        sectionWrap.classList.remove('open');
        sectionButton.setAttribute('aria-expanded', 'false');
      }

      function closeShortcutsMenu() {
        shortcutsWrap.classList.remove('open');
        shortcutsButton.setAttribute('aria-expanded', 'false');
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
        if (opts.rebuildStates || opts.rebuildScreens) {
          renderStates();
          renderVariants();
        }
        applyShellTheme();
        applyView();
        markActive();
        updateMarkers(opts);
        loadPreview();
      }

      function selectTab(tabId) {
        if (state.tab === tabId) return;
        state.tab = tabId;
        var tab = currentTab();
        state.screen = tab.screens[0].id;
        state.variant = tab.screens[0].variants[0].id;
        // If the active view isn't offered by the new tab, fall back to Freeform.
        var allowed = VIEW_IDS;
        if (allowed.indexOf(state.view) === -1) state.view = 'freeform';
        renderViewMenu();
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

      function stepScreen(delta) {
        var screens = currentTab().screens;
        var idx = -1;
        for (var i = 0; i < screens.length; i++) {
          if (screens[i].id === state.screen) { idx = i; break; }
        }
        var next = idx + delta;
        // Clamp at the ends — do nothing past either edge.
        if (next < 0 || next >= screens.length || next === idx) return;
        selectScreen(screens[next].id);
      }

      function stepState(delta) {
        // Arrow keys cycle through the states and then the design variants, so
        // left/right walks the whole right column.
        var sc = currentScreen();
        var variants = sc.variants.concat(sc.designVariants || []);
        var idx = -1;
        for (var i = 0; i < variants.length; i++) {
          if (variants[i].id === state.variant) { idx = i; break; }
        }
        var next = idx + delta;
        if (next < 0 || next >= variants.length || next === idx) return;
        selectVariant(variants[next].id);
      }

      sectionButton.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !sectionWrap.classList.contains('open');
        closeViewMenu();
        closeShortcutsMenu();
        sectionWrap.classList.toggle('open', open);
        sectionButton.setAttribute('aria-expanded', String(open));
      });
      sectionMenu.addEventListener('click', function (e) {
        var btn = e.target.closest('.section__option');
        if (!btn) return;
        selectTab(btn.getAttribute('data-tab'));
        closeSectionMenu();
      });
      screensList.addEventListener('click', function (e) {
        var btn = e.target.closest('.nav-item');
        if (btn) selectScreen(btn.getAttribute('data-screen'));
      });
      statesList.addEventListener('click', function (e) {
        var btn = e.target.closest('.nav-item');
        if (btn) selectVariant(btn.getAttribute('data-variant'));
      });
      variantsList.addEventListener('click', function (e) {
        var btn = e.target.closest('.nav-item');
        if (btn) selectVariant(btn.getAttribute('data-variant'));
      });
      function cycleTheme() {
        var i = THEME_ORDER.indexOf(state.theme);
        state.theme = THEME_ORDER[(i + 1) % THEME_ORDER.length];
        applyShellTheme();
        markActive();
        loadPreview();
      }
      themeCycleBtn.addEventListener('click', cycleTheme);
      motionBtn.addEventListener('click', cycleMotion);

      // Keep keyboard navigation with the gallery. A previewed page may pull
      // focus into one of its own fields (an autofocus attribute, or a script
      // that focuses an input — e.g. the device code cells). With focus inside
      // the iframe, the arrow keys feed that field instead of stepping the nav.
      // Same-origin, so after each preview loads we reach in and drop that
      // focus back to the gallery. Clicking a field still focuses it normally.
      frame.addEventListener('load', function () {
        try {
          var doc = frame.contentDocument;
          var el = doc && doc.activeElement;
          if (el && el !== doc.body && typeof el.blur === 'function') el.blur();
        } catch (e) {}
        window.focus();
      });

      // Toggle between the two sections (Getting in and Console) by selecting the other
      // tab. selectTab no-ops when the tab is unchanged, so the toggle only ever
      // flips to a genuinely different section.
      function toggleSection() {
        var current = currentTab();
        var other = TABS.filter(function (t) { return t.id !== current.id; })[0];
        if (other) selectTab(other.id);
      }

      // Cycle the view to the next allowed view for the current tab, wrapping at
      // the end (freeform -> browser -> mobile -> freeform). Mirrors a click on the matching view option.
      function cycleView() {
        var allowed = VIEW_IDS;
        var i = allowed.indexOf(state.view);
        state.view = allowed[(i + 1) % allowed.length];
        applyView();
      }

      viewButton.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !viewWrap.classList.contains('open');
        closeSectionMenu();
        closeShortcutsMenu();
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

      shortcutsButton.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !shortcutsWrap.classList.contains('open');
        closeSectionMenu();
        closeViewMenu();
        shortcutsWrap.classList.toggle('open', open);
        shortcutsButton.setAttribute('aria-expanded', String(open));
      });

      // The section + view menus close on a click outside themselves (each
      // popover, independently). The shortcuts popover is a passive reference
      // with no actionable rows, so ANY click dismisses it — even a click on its
      // own rows. The shortcuts button stops propagation, so its own toggle
      // still works (a click there never reaches this handler).
      document.addEventListener('click', function (e) {
        if (sectionWrap.classList.contains('open') && !sectionWrap.contains(e.target)) {
          closeSectionMenu();
        }
        if (viewWrap.classList.contains('open') && !viewWrap.contains(e.target)) {
          closeViewMenu();
        }
        if (shortcutsWrap.classList.contains('open')) {
          closeShortcutsMenu();
        }
      });

      // Keyboard shortcuts. Any key first dismisses every open popover (the
      // shortcuts reference disappears on the first keypress, and the
      // section/view menus get out of the way), then the matching action runs.
      // Arrows step the screen (up/down) and state (left/right) and preventDefault
      // so the page doesn't scroll. The letter shortcuts (A/V/T) toggle section,
      // cycle view, and cycle appearance — suppressed while typing in a form
      // control so they don't hijack text entry.
      document.addEventListener('keydown', function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        closeShortcutsMenu();
        closeSectionMenu();
        closeViewMenu();
        var t = e.target;
        var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
        if (e.key === 'ArrowDown') { e.preventDefault(); stepScreen(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); stepScreen(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); stepState(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); stepState(-1); }
        else if (!typing && (e.key === 'a' || e.key === 'A')) { toggleSection(); }
        else if (!typing && (e.key === 'v' || e.key === 'V')) { cycleView(); }
        else if (!typing && (e.key === 't' || e.key === 'T')) { cycleTheme(); }
        else if (!typing && (e.key === 'm' || e.key === 'M')) { cycleMotion(); }
      });

      renderSectionMenu();
      renderViewMenu();
      applyMotion();
      refresh({ rebuildScreens: true });
    })();
  </script>
</body>
</html>`;
}

/** Wrap Lucide path data in an SVG. */
function svgIcon(paths: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

const port = Number(process.env.PORT ?? 8650);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(
    `Marfa UI Viewer running at http://127.0.0.1:${String(info.port)}`,
  );
});
