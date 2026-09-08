import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Global setup builds the PG template database once per test run
    // (when DB_DIALECT=pg) and tears it down at the end. Per-file
    // clones are owned by `createPgTestStorage` in `src/test-utils.ts`.
    // No-op for the sqlite path. See src/storage/pg/test-template.ts
    // for the lifecycle rationale.
    globalSetup: ["./src/test-global-setup.ts"],

    // Generous default timeouts for PG tests: under parallel file
    // execution, CREATE DATABASE TEMPLATE / DROP DATABASE WITH (FORCE)
    // serialize briefly per template inside PG and can stack to a few
    // seconds when many workers spin up + tear down at once.
    // `hookTimeout` is larger because per-file afterAll runs DROP
    // DATABASE which serializes against PG-cluster-wide admin traffic
    // from every other file's per-test clone-and-drop traffic.
    //
    // 20s was "plenty for any test body + setup" on a quiet machine, and this
    // one is not: it hosts the self-hosted runner pool, so a suite competes
    // with whatever else the pool is running plus anything on the desktop.
    // Four separate tests have now been recorded failing here on elapsed time
    // rather than on an assertion, one of which let a pull request merge with
    // this job red. Every one of them waits on a condition and reports it, so
    // raising the ceiling cannot hide a defect — a test that never settles
    // still fails, later. The cost of being wrong this way is a slower red;
    // the other way it is a red that means nothing, which is worse, because it
    // teaches everyone to wave the next one through.
    testTimeout: 60_000,
    hookTimeout: 120_000,

    // Forks pool: each test file runs in its own child process, so the
    // process-global pubsub EventEmitter and the cycle-context
    // AsyncLocalStorage stay isolated per file. The template-DB pattern
    // (one cloned database per file, see storage/pg/test-template.ts)
    // makes that file-level parallelism PG-safe.
    //
    // Worker count is left at Vitest's default (cpus - 1). Pinning a
    // project-level `maxWorkers` here would differ from the sibling
    // projects' default, which forces Vitest to split this project into
    // its own `sequence.groupOrder` scheduling group; that re-grouping
    // starves the timing-sensitive cycle-attribution pubsub test under
    // CI scheduling. Connection pressure is bounded instead by the
    // per-file pool size (maxPoolSize: 3 in test-utils.ts), so the ceiling
    // is that size times the fork count rather than anything set here.
    pool: "forks",
  },
});
