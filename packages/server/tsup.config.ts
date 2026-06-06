import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    lib: "src/lib.ts",
    "worker-entry": "src/integrations/local-runtime/worker-entry.ts",
    // OpenTelemetry bootstrap, loaded via `node --import
    // ./dist/instrumentation.js` before the main entry so HTTP
    // instrumentation patches modules before they load.
    instrumentation: "src/instrumentation.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  external: ["@withmarfa/runtime-sdk", "@withmarfa/shared"],
});
