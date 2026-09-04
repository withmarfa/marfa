import { defineConfig } from "tsup";

/**
 * Three builds, because an Electron application is three programs that share
 * a repository and agree on almost nothing else.
 *
 * None of them cleans. tsup starts an array of configs concurrently, so a
 * `clean` on any one of them can empty the output folder after a sibling has
 * written into it — which produces a build that is missing a file it just
 * reported writing, intermittently. `build` clears the folder once before
 * tsup runs.
 */
export default defineConfig([
  {
    // Main. Ordinary Node with Electron's own API on top, and the only one of
    // the three that resolves packages at runtime — so its dependencies stay
    // external and load out of node_modules.
    entry: { main: "src/main.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    external: ["electron"],
  },
  {
    // Preload. CommonJS and self-contained, and neither is a preference.
    // Electron loads an ES-module preload only when the renderer is *not*
    // sandboxed, and this one is; and a sandboxed preload's `require`
    // resolves `electron` plus a few builtins and nothing off disk, so
    // anything it imports has to be inlined here.
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node22",
    external: ["electron"],
    noExternal: [/^@withmarfa\//],
  },
  {
    // Renderer. A browser bundle with no Node in it at all — which is not a
    // build setting so much as a statement about what the page is allowed to
    // be. It imports one type from the kit and nothing at runtime.
    //
    // A classic script rather than a module, and that is not a preference.
    // **A `<script type="module">` never loads from a `file://` page**:
    // module scripts are fetched under CORS, a file URL has an opaque
    // origin, and the request fails — with or without a CSP, in the same
    // directory or another. `loadFile` is a file URL, so the page would
    // render and the script would silently never run. Verified in Chromium
    // rather than reasoned about: the module form left the page blank and
    // the classic form ran, under identical CSP.
    entry: { renderer: "src/renderer.ts" },
    format: ["iife"],
    platform: "browser",
    target: "es2022",
    outExtension: () => ({ js: ".js" }),
  },
]);
