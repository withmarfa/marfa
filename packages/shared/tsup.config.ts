import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  // Inline @withmarfa/types runtime into the JS bundle so npm consumers don't
  // need the private types package at install time. tsup's dts emit doesn't
  // follow noExternal, so `scripts/inline-types-dts.mjs` (chained from the
  // `build` script in package.json) rewrites dist/index.d.ts to inline the
  // declarations too.
  noExternal: ["@withmarfa/types"],
});
