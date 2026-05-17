/**
 * tsup config for the local-runtime entry. Produces `dist/local.js`
 * which the server's local-runtime supervisor loads on boot
 * (`@mymehq/server`'s `loadInTreeRegistrations`). The Cloudflare-side
 * worker.ts is built by wrangler at deploy time and doesn't need this
 * config.
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
