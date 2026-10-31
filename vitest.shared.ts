import { FlakyReporter } from "./vitest.flaky-reporter.js";

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

/**
 * Retries a failing test once, only where `CI` is set. A pass on the retry is
 * reported as flaky by `FlakyReporter`, which `ciReporters` adds; nothing
 * retries on a developer's machine, where a flaky test should be seen. Spread
 * into the `test` block of each project that retries, since an inline project
 * inherits nothing from its parent. The performance, hydration and load
 * projects measure, and do not use it.
 */
export const ciRetry = {
  retry: (process.env.CI ?? "") === "" ? 0 : 1,
} as const;

/** The reporters for a root config: the default, plus the flaky report on CI. */
export const ciReporters = (): ("default" | FlakyReporter)[] =>
  (process.env.CI ?? "") === ""
    ? ["default"]
    : ["default", new FlakyReporter()];

/**
 * Takes the telemetry settings out of the environment and turns the OpenTelemetry
 * SDK off, so a developer's own shell settings never reach the `marfa` binary or
 * a server that a test run starts, and a command that fails on purpose is not
 * reported. Every Vitest config calls it while it loads, in the process that
 * starts the workers, so the workers and everything they spawn inherit the
 * result. A test that wants telemetry sets its own environment explicitly after
 * that.
 */
export function silenceTelemetry(env: Environment = process.env): void {
  for (const name of Object.keys(env)) {
    if (/^(OTEL_|MARFA_OTEL_|MARFA_POSTHOG_)/.test(name)) {
      Reflect.deleteProperty(env, name);
    }
  }
  env.OTEL_SDK_DISABLED = "true";
}

type Environment = Record<string, string | undefined>;

// This file is in no package's tsconfig, so Node's globals are not typed here.
declare const process: { env: Environment };
