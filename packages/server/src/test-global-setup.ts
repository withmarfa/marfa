/**
 * Vitest global setup for the server package.
 *
 * Three jobs. First, it refuses to run against a stale build (see
 * `assertBuiltDepsAreFresh`). Second, it sweeps temporary directories
 * abandoned by earlier runs (see `sweepStaleTempDirs`). Third, when
 * DB_DIALECT=pg, it builds the template database once before any test runs
 * and drops it once after all tests finish; per-file clones are owned by
 * `createPgTestStorage` in `test-utils.ts`.
 *
 * On the default sqlite path the database half is a no-op — sqlite tests
 * already get per-file isolation via `mkdtempSync` in `createTestContext`.
 *
 * Returned function is invoked by vitest at teardown.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
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

/**
 * Workspace dependencies this package imports through a built `dist` rather
 * than from source. Each entry is a directory under `packages/`.
 */
const BUILT_DEPS = ["types", "shared"] as const;

/** Newest mtime beneath `dir`, or 0 if it does not exist. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // Raced with a concurrent build or clean; skip it.
      }
    }
  }
  return newest;
}

/**
 * Refuse to run when a dependency's source is newer than its build.
 *
 * These tests import sibling packages through their compiled `dist`, so a
 * source change that has not been rebuilt is invisible: the suite runs
 * happily against the previous version and reports on it as though it were
 * current. That is the worst shape of false signal, because nothing about it
 * looks wrong — it is confident, reproducible, and answering a question
 * nobody asked.
 *
 * It has cost real time twice. Once a local run and CI disagreed about the
 * same commit and both were right, because one had rebuilt the type registry
 * and the other had not. Once a just-merged validation appeared not to work.
 * Both were diagnosed as code problems first.
 *
 * A timestamp comparison rather than a content hash: it is cheap, it needs no
 * build-tool cooperation, and the failure it guards against is always
 * "source edited, build not re-run", which moves mtime. CI builds before it
 * tests, so this is silent there.
 */
function assertBuiltDepsAreFresh(): void {
  const packagesDir = join(import.meta.dirname, "..", "..");
  const stale: string[] = [];

  for (const dep of BUILT_DEPS) {
    const src = join(packagesDir, dep, "src");
    const dist = join(packagesDir, dep, "dist");
    if (!existsSync(src)) continue;

    const builtAt = newestMtime(dist);
    if (builtAt === 0) {
      stale.push(`@withmarfa/${dep} (never built)`);
      continue;
    }
    if (newestMtime(src) > builtAt) stale.push(`@withmarfa/${dep}`);
  }

  if (stale.length === 0) return;

  throw new Error(
    [
      "",
      "Refusing to run: these packages have source newer than their build,",
      "so the suite would test the previous version and report on it as",
      "though it were current.",
      "",
      ...stale.map((s) => `  - ${s}`),
      "",
      "Rebuild, then re-run:",
      "",
      "  pnpm build",
      "",
    ].join("\n"),
  );
}

export default async function setup(): Promise<() => Promise<void>> {
  assertBuiltDepsAreFresh();
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
