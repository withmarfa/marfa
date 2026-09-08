/**
 * Projects a space status read back from storage onto the status union,
 * and builds the `Space` every read of that table returns.
 *
 * Eight row projections reached the column with a bare cast, and a cast
 * asserts rather than checks. The column is `text NOT NULL DEFAULT
 * 'active'` in both dialects, so it is never absent and never null, but
 * **nothing constrains its contents**: there is no CHECK. Enforcement is
 * a single equality against `"suspended"`
 * (`middleware/space-suspension.ts`), so any other value failed it and
 * read as a space in good standing, and the writes the suspension exists
 * to stop were accepted.
 *
 * `isSpaceStatus` in `@withmarfa/shared` is the definition of a valid
 * status and stays free of any logging concern, because it ships to npm.
 * What belongs here is the policy for meeting a bad one.
 *
 * **Where a bad value can actually come from.** Only `setStatus` writes
 * this column and it takes a typed `SpaceStatus`, so nothing reachable
 * from TypeScript can store one. That leaves a hand-written UPDATE
 * against the database, and a value a newer build wrote met by an older
 * one after a rollback. Both are real and neither is common, which is
 * the point: this is the failure that sits unnoticed rather than the one
 * that pages someone.
 *
 * **This defaults to `suspended`, which is the restrictive end.** A value
 * nothing recognizes says the row is in a state this build cannot reason
 * about, and the only safe reading of that is the one that withholds
 * rather than the one that admits.
 *
 * **The cost of leaning that way, stated rather than skipped.** The
 * motivating case is a hand-repair typing `"Suspended"`, where the old
 * behaviour silently bypassed the gate. The same hand-repair typing
 * `"Active"` now takes that space's writes down, where before it read as
 * active and happened to be right. So this trade is not free, and the
 * argument for it is not that a bad value is always restrictive.
 *
 * The argument is that the two outcomes are not equally recoverable. A
 * wrongly-suspended space returns a loud 403 naming its reason, reads
 * still pass, the operator key bypasses the gate entirely, the error log
 * names the row and the true stored string, and
 * `POST /admin/spaces/{id}/unsuspend` overwrites the column
 * unconditionally. A wrongly-active space produces no signal at all, and
 * the suspension an operator believes is in force is not. **Prefer the
 * failure that announces itself.**
 *
 * **On a status a later build might add**, the honest position is weaker
 * than "restrictions only" — `trial` or `grace_period` are perfectly
 * plausible states where writes should continue. It is a lean rather
 * than a rule, and it is only ever consulted on the rollback path, where
 * the alternative is honouring a value this build provably cannot
 * interpret. The recoverability argument above carries the decision; this
 * only says the lean does not point the wrong way.
 */
import { isSpaceStatus, type Space, type SpaceStatus } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";

/** The shape both dialects' `spaces` selects return for a full row. */
export interface SpaceRow {
  id: string;
  name: string | null;
  created_at: string;
  status: string;
}

/**
 * Narrows a stored space status, logging when the stored value was not
 * one this build knows.
 *
 * `id` is carried so the log line names the row rather than costing the
 * reader the same investigation every time, and the true stored string is
 * logged because nothing else surfaces it: once projected, every API
 * response reports `"suspended"` and the log is the only place the
 * original survives.
 */
export function storedSpaceStatus(value: unknown, id: string): SpaceStatus {
  if (isSpaceStatus(value)) return value;
  log("error", "stored space status is not one this build recognizes", {
    table: "spaces",
    column: "status",
    row_id: id,
    // `typeof null` is `"object"`, which says nothing useful, so null is
    // named. The column is NOT NULL so this should be unreachable, and
    // that is exactly why it is worth reporting legibly if it ever is.
    stored_status:
      typeof value === "string"
        ? value
        : value === null
          ? "null"
          : typeof value,
    projected_as: "suspended",
  });
  return "suspended";
}

/**
 * Builds a `Space` from a row, guarding the status on the way.
 *
 * Both dialects have four reads that return a whole space and each used
 * to narrow the status by hand. That is eight copies of one decision,
 * and the copy is the failure mode: a ninth read, or a third dialect,
 * silently skips the guard because nothing makes calling it the default.
 * The same consolidation was made one commit earlier for the type
 * table's provenance columns, for the same reason.
 */
export function spaceFromRow(row: SpaceRow): Space {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    status: storedSpaceStatus(row.status, row.id),
  };
}
