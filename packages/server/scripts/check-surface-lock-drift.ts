/**
 * Refuse a change that moves a package's recorded surface without moving its
 * version.
 *
 * The sibling check, `published-surface.test.ts`, compares the lock against
 * the tree. That comparison is silenced by regenerating, which is also the
 * documented remedy for it — so the one path through the guard that stays
 * open is the one a careful author walks down. This compares the committed
 * lock against the lock on the base being merged into, which regenerating
 * cannot silence: regenerating is what produces the second surface.
 *
 * Takes the base ref as its only argument. Run from anywhere in the
 * repository.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareSurfaceLocks,
  describeSurfaceLockDrift,
  type SurfaceLock,
} from "../src/publishing/published-surface.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = resolve(SERVER_ROOT, "published-surface-lock.json");
const LOCK_IN_REPO = "packages/server/published-surface-lock.json";

const baseRef = process.argv[2];
if (!baseRef) {
  console.error(
    "usage: check-surface-lock-drift <base-ref>\n" +
      "The ref this change merges into. Without it there is nothing to compare against.",
  );
  process.exit(2);
}

/**
 * Read the lock as of a ref.
 *
 * **Every failure here exits non-zero**, including the ref not existing and
 * the file being absent from it. A check that cannot see its baseline knows
 * nothing, and the one thing it must never do is report that as agreement —
 * a shallow clone, a force-pushed base or a rename would otherwise turn this
 * guard off with no output and a green tick. If the baseline genuinely has
 * no lock, that is a repository this check has not been taught about yet,
 * and saying so out loud is the correct response.
 */
function lockAtRef(ref: string): SurfaceLock {
  let raw: string;
  try {
    raw = execFileSync("git", ["show", `${ref}:${LOCK_IN_REPO}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    console.error(
      `Could not read ${LOCK_IN_REPO} at ${ref}, so there is no baseline to compare against.\n` +
        "A shallow checkout is the usual cause: this needs the base commit, which means fetch-depth: 0.\n" +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(2);
  }
  return JSON.parse(raw) as SurfaceLock;
}

const baseline = lockAtRef(baseRef);
const head = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as SurfaceLock;

const drifts = compareSurfaceLocks(baseline, head);
if (drifts.length === 0) {
  console.log(
    `published surface lock: no package's surface moved under a standing version (${String(Object.keys(head).length)} packages, base ${baseRef})`,
  );
  process.exit(0);
}

console.error(
  `A published surface moved without its version moving, in ${String(drifts.length)} package${drifts.length === 1 ? "" : "s"}:\n`,
);
for (const d of drifts) console.error(`  - ${describeSurfaceLockDrift(d)}\n`);
process.exit(1);
