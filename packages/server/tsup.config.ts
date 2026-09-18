import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    lib: "src/lib.ts",
    // OpenTelemetry bootstrap, loaded via `node --import
    // ./dist/instrumentation.js` before the main entry so HTTP
    // instrumentation patches modules before they load.
    instrumentation: "src/instrumentation.ts",
    // Standalone migrator so a deployment can run migrations
    // (`node dist/migrate.js`) without tsx.
    migrate: "src/storage/migrate.ts",
  },
  format: ["esm"],
  // Declarations for the one entry anything imports. `exports` exposes
  // `dist/lib.d.ts` and nothing else; the other entries are programs, and
  // their generated declarations came to between 13 and 507 bytes each while
  // costing a full type-graph pass apiece in the dts worker.
  //
  // That cost was not free. Adding a sixth entry once took the worker past
  // the memory it had in a container build, and the deploy failed with
  // ERR_WORKER_OUT_OF_MEMORY having passed every local build.
  dts: { entry: { lib: "src/lib.ts" } },
  clean: true,
  target: "node20",
  external: ["@withmarfa/shared"],
});
