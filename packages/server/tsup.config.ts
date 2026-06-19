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
    // Standalone migrator so an image-based deploy can run migrations
    // (`node dist/migrate.js`) without tsx — used by the docker-compose
    // self-host path.
    migrate: "src/storage/migrate.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  // pg-boss opens its own pg pool and creates the pgboss schema; resolve it
  // from node_modules at runtime rather than bundling it. Only the local (pg)
  // integration substrate imports it, dynamically.
  external: ["@withmarfa/runtime-sdk", "@withmarfa/shared", "pg-boss"],
});
