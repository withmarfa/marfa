/**
 * The test and hook budget every package shares unless it has chosen its own.
 *
 * This cannot live in the root `vitest.config.ts`'s `test` block, which is
 * where it looked like it lived for a long time. Vitest applies a root `test`
 * block to *inline* projects only: "projects referenced as external files or
 * directories do not inherit from the root config automatically". The root
 * declares `projects: ["packages/*"]`, a directory glob, so its `testTimeout`
 * and `hookTimeout` reached nothing at all. Every package but `server` ran on
 * Vitest's stock 10s default, and on a machine that also hosts the CI runner
 * pool the first thing to fail whenever anything else was running was a budget
 * nobody had picked. It failed as a timeout, which is indistinguishable at a
 * glance from a defect.
 *
 * Imported rather than copied into each package. Seven copies of a number
 * drift, and the failure drift produces here is a timeout — the one failure
 * shape that gets investigated as real before anyone thinks to check the
 * clock.
 *
 * The numbers are the ones the root config already declared and reasoned
 * about; what changed is that they now reach the packages. A package that
 * needs more says so in its own config, next to why.
 */
export const sharedTestBudget = {
  testTimeout: 20_000,
  hookTimeout: 20_000,
} as const;
