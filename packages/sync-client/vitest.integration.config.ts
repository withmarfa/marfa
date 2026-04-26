import { defineConfig } from "vitest/config";

/**
 * Integration test config — opt-in. These tests spawn a local Myme
 * server (the worktree code) configured to talk to Atlas Postgres
 * (`myme_mock`) + Atlas Electric (`:8604`). They self-skip when Atlas
 * is unreachable or when `MYME_INTEGRATION_*` env vars are missing.
 *
 * - `pool: 'forks'` — each test file forks its own Node process so
 *   spawned server children are isolated and ports don't collide.
 * - `fileParallelism: false` — only one server boots at a time.
 *   Integration cost is dominated by server boot, and parallelism
 *   would have multiple servers fighting over Postgres + Electric
 *   replication slots on the mock instance.
 * - 30s test / 60s hook timeouts — bootstrapping the server (cold
 *   `tsx` start + initial Electric snapshot) can take 5-10s on a
 *   warm box.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.integration.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
