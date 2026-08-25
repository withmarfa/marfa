import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Per-package projects. Packages without their own vitest config
    // (shared, sdk, types) inherit from this root config when their
    // directory is matched.
    projects: [
      "packages/*",
      {
        // `ci/` holds tests over the repository's own CI configuration
        // rather than over any package, so the glob above cannot reach it
        // and it has no package.json to be discovered by. Named inline so
        // the whole project set is readable in one place. Not `.github/`:
        // a leading dot is skipped by the globber unless asked for, and a
        // test that silently matches nothing reports a confident pass.
        test: {
          name: "ci-config",
          include: ["ci/**/*.test.ts"],
        },
      },
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
