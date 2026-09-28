import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Global setup refuses a stale build and sweeps temporary directories
    // abandoned by earlier runs; see src/test-global-setup.ts.
    globalSetup: ["./src/test-global-setup.ts"],

    // Allow condition-based integration tests to settle under shared CPU load.
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
