/**
 * Hold the contract's statement IDs to a base:
 *
 *   tsx scripts/check-spec-ids.ts [<git-ref>]
 *
 * Every ID that was a statement or a retired statement at the reference,
 * `origin/main` unless one is named, must still be one in the working tree,
 * and a retired ID must not be a statement again. A statement leaves by
 * moving to its chapter's Retired list, never by being deleted or renamed.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  idHistoryBreaks,
  idSetsAt,
  idSetsOf,
} from "../src/utils/spec-id-history.js";
import { readChapters } from "../src/utils/spec-statements.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ref = process.argv[2] ?? "origin/main";

try {
  const base = idSetsAt(ref, repository);
  const breaks = idHistoryBreaks(base, idSetsOf(readChapters().values()));
  if (breaks.length > 0) {
    console.error(`The contract's IDs differ from ${ref}:`);
    for (const line of breaks) console.error(`  ${line}`);
    process.exitCode = 1;
  } else {
    console.log(
      `${String(base.active.size)} statements and ${String(base.retired.size)} retired IDs at ${ref} are all still there.`,
    );
  }
} catch (error) {
  console.error(
    `Could not read the IDs at ${ref}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
