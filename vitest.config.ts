import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Per-package projects. Packages without their own vitest config
    // (shared, sdk, types) inherit from this root config when their
    // directory is matched. Integrations all ship a vitest.config.ts
    // so we glob those specifically — avoids vitest tripping on
    // per-folder docs like `integrations/CLAUDE.md`.
    //
    // The withmarfa.inbox integration ships a sibling Cloudflare Email
    // Worker at `integrations/withmarfa-inbox/email-worker/` with its
    // own vitest.config.ts, the only nested-workspace package today.
    projects: [
      "packages/*",
      "infra/cloudflare/vitest.config.ts",
      "integrations/*/vitest.config.ts",
      "integrations/*/email-worker/vitest.config.ts",
    ],
    // PG parallelism is owned by the server package's own vitest config:
    // each test file clones a fresh PG database from the template
    // (`packages/server/src/storage/pg/test-template.ts`), so workers
    // don't share state and file-parallelism is safe. SQLite was always
    // parallel-safe (each file uses its own tmpdir DB).
    //
    // PG-side: CREATE DATABASE TEMPLATE / DROP DATABASE WITH (FORCE)
    // serialize briefly per template, so per-file setup + teardown can
    // run a few seconds under heavy parallel contention. 20s default
    // is generous enough that a real hang still surfaces fast.
    // `hookTimeout` covers `beforeAll` / `afterAll` (the per-file
    // template-clone lifecycle uses both).
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
