/// <reference types="node" />
import { appendFileSync } from "node:fs";

/**
 * The parts of Vitest's `TestCase` this reads. Vitest's own type is not used:
 * a package and the root can resolve two copies of Vitest, and their
 * `TestCase` classes do not match each other.
 */
interface FlakyCase {
  readonly fullName: string;
  readonly module: { readonly relativeModuleId: string };
  diagnostic(): { flaky: boolean; retryCount: number } | undefined;
}

/**
 * Names every test that failed and then passed on its retry.
 *
 * A retry turns a failing test green, so without this a flaky test passes CI
 * and nobody learns of it. Each one is written to the job summary, where the
 * run's page shows it, and to the log as a warning annotation. A test that
 * appears here more than once is filed and fixed at its cause.
 *
 * Added to the reporters only when `CI` is set, next to the retry itself in
 * `ciRetry`, so a run on a developer's machine neither retries nor reports.
 */
export class FlakyReporter {
  private readonly flaky: FlakyCase[] = [];

  onTestCaseResult(testCase: FlakyCase): void {
    if (testCase.diagnostic()?.flaky === true) this.flaky.push(testCase);
  }

  onTestRunEnd(): void {
    if (this.flaky.length === 0) return;
    const lines = this.flaky.map((testCase) => {
      const retries = testCase.diagnostic()?.retryCount ?? 0;
      return `| \`${testCase.module.relativeModuleId}\` | ${testCase.fullName.replaceAll("|", "\\|")} | ${String(retries)} |`;
    });
    for (const testCase of this.flaky) {
      console.log(
        `::warning file=${testCase.module.relativeModuleId}::flaky test, failed and then passed on retry: ${testCase.fullName}`,
      );
    }
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary === undefined || summary === "") return;
    appendFileSync(
      summary,
      [
        "### Flaky tests (passed only on retry)",
        "",
        "| File | Test | Retries |",
        "| --- | --- | --- |",
        ...lines,
        "",
      ].join("\n"),
    );
  }
}
