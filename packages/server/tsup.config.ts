import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // OpenTelemetry bootstrap, loaded via `node --import
    // ./dist/instrumentation.js` before the main entry so HTTP
    // instrumentation patches modules before they load.
    instrumentation: "src/instrumentation.ts",
    // Run by `deploy/entrypoint.sh` before replication starts, on its own.
    "replica-check": "src/replica-check.ts",
  },
  format: ["esm"],
  // Every entry is a program: nothing imports the server, so no
  // declarations are built.
  dts: false,
  clean: true,
  target: "node20",
  external: ["@withmarfa/shared"],
  // `schema-shape.ts` and `migrations.ts` read `schema.sql` and
  // `schema-1.sql` from beside themselves, and the bundles they are folded
  // into sit at the top of `dist/`.
  onSuccess:
    "cp src/storage/sqlite/schema.sql dist/schema.sql && cp src/storage/sqlite/schema-1.sql dist/schema-1.sql",
});
