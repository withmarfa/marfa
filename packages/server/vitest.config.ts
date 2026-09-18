import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Global setup refuses a stale build and sweeps temporary directories
    // abandoned by earlier runs; see src/test-global-setup.ts.
    globalSetup: ["./src/test-global-setup.ts"],

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
    // process-global pubsub EventEmitter stays isolated per file, and each
    // file's own temporary database makes that parallelism safe.
    //
    // Worker count is left at Vitest's default (cpus - 1). Pinning a
    // project-level `maxWorkers` here would differ from the sibling
    // projects' default, which forces Vitest to split this project into
    // its own `sequence.groupOrder` scheduling group.
    pool: "forks",
  },
});
