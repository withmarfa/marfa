import { defineConfig } from "tsup";

export default defineConfig({
  entry: { local: "src/local.ts" },
  format: ["esm"],
  target: "node20",
  dts: false,
  clean: true,
  external: ["@mymehq/runtime-sdk", "@mymehq/shared"],
});
