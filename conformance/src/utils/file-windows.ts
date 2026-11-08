import { writeFileSync } from "node:fs";
import type { Reporter, TestModule } from "vitest/node";

/** When a test file started and ended, hooks included, by its path. */
export type FileWindows = Record<string, { start: number; end: number }>;

/**
 * Writes each test file's window to the file `MARFA_FILE_WINDOWS` names.
 *
 * Vitest's JSON report cannot place a request in a file: its `startTime` and
 * `endTime` bound the tests alone, so `beforeAll` and `afterAll` fall outside
 * them, and a file whose `beforeAll` failed has the run's own start for both.
 */
export default class FileWindowsReporter implements Reporter {
  private readonly windows: FileWindows = {};

  onTestModuleQueued(testModule: TestModule): void {
    const now = Date.now();
    this.windows[testModule.moduleId] = { start: now, end: now };
  }

  onTestModuleEnd(testModule: TestModule): void {
    const window = this.windows[testModule.moduleId];
    if (window !== undefined) window.end = Date.now();
  }

  onTestRunEnd(): void {
    const path = process.env.MARFA_FILE_WINDOWS;
    if (path === undefined || path === "") {
      throw new Error("the file windows reporter needs MARFA_FILE_WINDOWS");
    }
    writeFileSync(path, `${JSON.stringify(this.windows)}\n`);
  }
}
