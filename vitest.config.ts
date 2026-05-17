import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    // PG parallelism is owned by the server package's own vitest config:
    // each test file clones a fresh PG database from the template
    // (`packages/server/src/storage/pg/test-template.ts`), so workers
    // don't share state and file-parallelism is safe. SQLite was always
    // parallel-safe (each file uses its own tmpdir DB).
    //
    // PG-side: CREATE DATABASE TEMPLATE / DROP DATABASE WITH (FORCE)
    // serialise briefly per template, so per-file setup + teardown can
    // run a few seconds under heavy parallel contention. 20s default
    // is generous enough that a real hang still surfaces fast.
    // `hookTimeout` covers `beforeAll` / `afterAll` (the per-file
    // template-clone lifecycle uses both).
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
