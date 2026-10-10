import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // OpenTelemetry bootstrap, loaded via `node --import
    // ./dist/instrumentation.js` before the main entry so HTTP
    // instrumentation patches modules before they load.
    instrumentation: "src/instrumentation.ts",
  },
  format: ["esm"],
  // Every entry is a program: nothing imports the server, so no
  // declarations are built.
  dts: false,
  clean: true,
  target: "node20",
  external: ["@withmarfa/shared"],
  // `connection.ts` reads `schema.sql` from beside itself, and the bundles
  // it is folded into sit at the top of `dist/`.
  onSuccess: "cp src/storage/sqlite/schema.sql dist/schema.sql",
});
