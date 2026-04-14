import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  // Inline @mymehq/types so npm consumers of @mymehq/shared don't need the
  // private types package at install time.
  noExternal: ["@mymehq/types"],
});
