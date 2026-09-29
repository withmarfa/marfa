/**
 * The test and hook budget every package shares unless it has chosen its own.
 *
 * It cannot live in the root `vitest.config.ts`'s `test` block: a project
 * matched by the `packages/*` glob inherits nothing from it, and neither
 * does the inline `ci-config` project, so each spreads this in its own
 * block. Without it a test runs on Vitest's stock 5s budget, and on a busy
 * machine the first sign is a timeout in a file the change never touched,
 * which reads as a defect.
 *
 * Imported rather than copied, because copies drift and drift here fails as
 * a timeout, the one failure investigated as real before anyone checks the
 * clock. A package that needs more says so in its own config, next to why.
 */
export const sharedTestBudget = {
  testTimeout: 20_000,
  hookTimeout: 20_000,
} as const;
