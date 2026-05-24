/**
 * tsup config for the local-runtime entry. Produces `dist/local.js`
 * which the server's local-runtime supervisor loads on boot.
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { local: "src/local.ts" },
  format: ["esm"],
  target: "node20",
  dts: false,
  clean: true,
  external: ["@mymehq/runtime-sdk", "@mymehq/shared"],
});
