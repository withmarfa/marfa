import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Global setup builds the PG template database once per test run
    // (when STORAGE_DIALECT=pg) and tears it down at the end. Per-file
    // clones are owned by `createPgTestStorage` in `src/test-utils.ts`.
    // No-op for the sqlite path. See src/storage/pg/test-template.ts
    // for the lifecycle rationale.
    globalSetup: ["./src/test-global-setup.ts"],

    // Generous default timeouts for PG tests: under parallel file
    // execution, CREATE DATABASE TEMPLATE / DROP DATABASE WITH (FORCE)
    // serialise briefly per template inside PG and can stack to a few
    // seconds when many workers spin up + tear down at once. 20s is
    // plenty for any test body + setup; a real hang still surfaces fast.
    // `hookTimeout` is larger because per-file afterAll runs DROP
    // DATABASE which serialises against PG-cluster-wide admin traffic
    // from every other file's per-test clone-and-drop traffic.
    testTimeout: 20_000,
    hookTimeout: 60_000,

    // Cap worker forks to keep PG resource contention sane. The
    // template-DB pattern serialises clones briefly (CREATE DATABASE
    // FROM TEMPLATE), and each per-file pool holds a few connections.
    // 6 workers × (3 storage + 1 admin) ≈ 24 peak connections —
    // comfortably under PG default `max_connections=100`.
    // Pre-template-DB this used to be 1 (fileParallelism=false); the
    // 6× speedup over that is plenty.
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 6,
        minForks: 1,
      },
    },
  },
});
