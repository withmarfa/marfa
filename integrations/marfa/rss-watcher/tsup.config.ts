/**
 * tsup config for the runtime entry. Produces `dist/local.js`, which
 * the server's supervisor loads on boot (`@withmarfa/server`'s
 * `loadInTreeRegistrations`).
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { local: "src/local.ts" },
  format: ["esm"],
  target: "node20",
  dts: false,
  clean: true,
  external: ["@withmarfa/runtime-sdk", "@withmarfa/shared"],
});
