/**
 * Reports a stored type whose identifier sits under a namespace nothing is
 * allowed to occupy.
 *
 * Some of the reserved roots name no namespace tier: every root a scope
 * family lives under, and the word the glossary bans, kept reserved so
 * nobody may claim it. How many there are is not written down here — the
 * scan below derives them, and a count in prose is the thing that goes stale when the set grows.
 * Reserving them is what stops a registered type ever sharing a first segment
 * with a grant, so a row under one is a type whose identifier collides with a
 * permission literal — the one collision the reservation exists to make
 * impossible.
 *
 * **Registration cannot produce one, which is why this reports rather than
 * refuses.** `isValidTypeIdentifier` consults `RESERVED_ROOTS`, so every
 * credential is turned down at `POST /types`. What can produce one is a root
 * being reserved after the fact: a row written while the word was ordinary.
 * An archive cannot carry one in, because the restore validates each
 * identifier against the same reserved set. Every deployment is checked before
 * a root is reserved, and none held such a row, so this is expected to stay
 * silent, and that is precisely the state in which a silent check is worth
 * having, because the only thing it can ever report is something nobody
 * predicted.
 *
 * It follows `platform-family.ts`: recognize, say so loudly enough that the
 * report cannot be mistaken for normal, and let the server start. Refusing to
 * boot over a row nothing is using would turn an orphaned type into an
 * instance that cannot come up to be repaired.
 *
 * **The tierless roots are derived, not listed.** `classifyNamespace` places
 * the five roots that name a tier and falls through to `publisher` for
 * everything else, so a reserved root that classifies as `publisher` is
 * exactly a reserved root with no tier. A second list beside `RESERVED_ROOTS`
 * would be free to drift from it, and drift here means a root reserved in one
 * place and unreported in the other.
 *
 * **This reads stored types and nothing else, which is half of what
 * reserving a root can strand.** The other half is a publisher handle: the
 * same word can already be held by a user, in a different table, and after
 * the reservation that user holds a handle nobody could claim today. Nothing
 * here would ever say so — it is handed `types` rows and has no view
 * of accounts. Every deployment is checked for both before a root is
 * reserved and none has held either, so the gap is in what would be noticed
 * later rather than in what shipped.
 *
 * It is left as a gap deliberately. Widening this to accounts would make a
 * boot-time log the place a person first learns their handle was taken from
 * them, and a stranded handle needs a decision and a conversation rather than
 * an `error` line the next restart repeats. What reserving a root owes is a
 * check before it lands, which is a migration-time question and not this
 * one's.
 */
import { classifyNamespace, isReservedRoot } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import type { LoadedType } from "./interface.js";

/**
 * Logs one `error` per stored type sitting under a tierless reserved root,
 * naming the row. Returns the identifiers it reported, so a caller (and a
 * test) can observe the result rather than only the log.
 */
export function reportReservedRootRows(
  loaded: readonly LoadedType[],
): string[] {
  const reported: string[] = [];

  for (const row of loaded) {
    const id = row.schema.id;
    const root = id.split(".", 1)[0] ?? "";
    if (!isReservedRoot(root)) continue;
    // A reserved root that names a tier is legitimate here: `user.note` and
    // `app.thing.item` are ordinary registrations, and `core.*` / `system.*` /
    // `marfa.*` are the platform's own rows. Only the tierless ones are wrong.
    if (classifyNamespace(id) !== "publisher") continue;

    reported.push(id);
    log("error", "stored type sits under a reserved root that names no tier", {
      table: "types",
      column: "id",
      row_id: id,
      reserved_root: root,
      origin: row.origin,
      action: "reported, not removed",
    });
  }

  return reported;
}
