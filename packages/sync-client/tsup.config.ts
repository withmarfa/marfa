import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  // Browser AND Node — the package targets Electron renderer, Electron
  // main, and the browser. tsup's `target` accepts a single value; we
  // use the lower (es2020) so esbuild emits compatible output for all.
  target: "es2020",
  // SQL migrations and other static assets live under src/ but should
  // be copied into dist/ at build time.
  loader: {
    ".sql": "text",
  },
  // Externalise React so the bundle stays small; consumers bring their
  // own. PGlite, electric, tanstack are real runtime deps and stay
  // bundled per ESM convention.
  external: ["react", "react-dom"],
});
