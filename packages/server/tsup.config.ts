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
    // Ships for the same reason the migrator does: a managed database accepts
    // connections only from inside its own network, so the deployment host is
    // the only place this can run, and there is no checkout there to run tsx
    // against.
    "seed-oauth-clients": "src/scripts/seed-oauth-clients.ts",
    // The client manifests, as their own entry so the in-image verification
    // can read the set this build actually ships without importing the
    // server. Importing `lib.js` would pull the whole route tree and the
    // storage layer in to read one array, and hardcoding the names in the
    // verification would be a fourth hand-maintained enumeration of a set
    // the code already states once.
    //
    // It costs a bundle pass and no dts pass: `dts` names its entries
    // explicitly, which is what keeps the heap ceiling above this.
    "client-manifests": "src/integrations/client-manifests.ts",
  },
  format: ["esm"],
  // Declarations for the one entry anything imports. `exports` exposes
  // `dist/lib.d.ts` and nothing else; the other entries are programs, and
  // their generated declarations came to between 13 and 507 bytes each while
  // costing a full type-graph pass apiece in the dts worker.
  //
  // That cost was not free. Adding a sixth entry took the worker past the
  // memory it gets inside the image build, and deploys to both environments
  // failed with ERR_WORKER_OUT_OF_MEMORY having passed every local build and
  // the whole CI matrix, none of which built the image. The `Server image`
  // workflow does now, on merges, so the next thing that grows past that
  // ceiling turns `main` red rather than blocking a release.
  dts: { entry: { lib: "src/lib.ts" } },
  clean: true,
  target: "node20",
  // pg-boss opens its own pg pool and creates the pgboss schema; resolve it
  // from node_modules at runtime rather than bundling it. Only the local (pg)
  // integration substrate imports it, dynamically.
  external: ["@withmarfa/runtime-sdk", "@withmarfa/shared", "pg-boss"],
});
