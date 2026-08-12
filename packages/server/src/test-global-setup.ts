/**
 * Vitest global setup for the server package.
 *
 * Two jobs. First, it sweeps temporary directories abandoned by earlier
 * runs (see `sweepStaleTempDirs`). Second, when DB_DIALECT=pg, it builds
 * the template database once before any test runs and drops it once
 * after all tests finish; per-file clones are owned by
 * `createPgTestStorage` in `test-utils.ts`.
 *
 * On the default sqlite path the database half is a no-op — sqlite tests
 * already get per-file isolation via `mkdtempSync` in `createTestContext`.
 *
 * Returned function is invoked by vitest at teardown.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTemplate, dropTemplate } from "./storage/pg/test-template.js";

/**
 * Directories older than this cannot belong to a run that is still going,
 * so removing them is safe even while another suite is executing beside
 * this one. Generous on purpose: the cost of leaving one extra directory
 * for an hour is nothing, and the cost of deleting a live one is a
 * confusing failure in an unrelated suite.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Remove `marfa-*` temporary directories left behind by earlier runs.
 *
 * Every test context removes its own directory now, so in ordinary
 * operation this finds nothing. It exists for the case nothing in-process
 * can cover: a run killed outright, by a CI timeout or a `SIGKILL`, which
 * leaves the directory with no code left running to remove it.
 *
 * Deliberately at setup rather than teardown. A teardown hook does not run
 * when the process is killed either, so it would miss exactly the case
 * this is for; and sweeping while other suites are live risks deleting a
 * directory somebody is still using. Sweeping stale entries on the way in
 * has neither problem.
 */
function sweepStaleTempDirs(): void {
  const root = tmpdir();
  const cutoff = Date.now() - STALE_AFTER_MS;
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    // An unreadable temp root is not a reason to fail the suite.
    return;
  }

  for (const name of entries) {
    if (!name.startsWith("marfa-")) continue;
    const path = join(root, name);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Raced with another sweep, or not ours to remove. Either way the
      // next run will try again.
    }
  }

  if (removed > 0) {
    console.log(
      `[test-setup] removed ${String(removed)} abandoned temp ${
        removed === 1 ? "directory" : "directories"
      }`,
    );
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  sweepStaleTempDirs();

  if (process.env.DB_DIALECT !== "pg") {
    // sqlite path — nothing to do here.
    return async () => {
      /* no PG resources to release on the sqlite path */
    };
  }

  await buildTemplate();

  return async () => {
    await dropTemplate();
  };
}
