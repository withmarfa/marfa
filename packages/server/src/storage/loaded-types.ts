/**
 * One mapping from a `types` row to a `LoadedType`, shared by every method
 * that reads the table with provenance, so that what an unreadable column
 * means is decided once rather than per reader.
 *
 * **`family` is passed through rather than validated here, deliberately.**
 * The boot projection is what decides where an unplaceable platform row
 * goes, and it logs the value it found to say so. Narrowing the column to
 * recognized-or-absent in this function would leave that log reporting
 * `undefined` for every case, including the one it exists for: an older
 * build meeting a family a newer build wrote. The reader that acts on a
 * value is the reader that should see it.
 *
 * **`origin` is different, and the difference is worth stating** because
 * the obvious symmetry is wrong. It is validated, but it is not projected
 * onto a value the code goes on to trust. A stored string outside the
 * union already fails `=== "platform"` and `=== "user"` alike, so it is
 * excluded from the shipped vocabulary and from a person's own
 * registrations both — fail-closed on every consumer without anything
 * being decided for it. An earlier draft of this file "improved" that by
 * projecting an unrecognized value to `user`, which reads as the cautious
 * choice and is the permissive one: `user` is exactly what the consent
 * screen treats as the person's own to offer a read-and-write wildcard
 * over. Passing the value through unchanged is what keeps both doors shut.
 */
import { isValidTypeOrigin, type TypeSchema } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import type { LoadedType } from "./interface.js";
import { safeJsonParse } from "./json-utils.js";

/** The shape a `types` select returns. */
export interface TypeRow {
  id: string;
  schema: string;
  /** `NOT NULL DEFAULT 'user'`, so never absent. */
  origin: string;
  family: string | null;
  owner_connector: string | null;
}

/**
 * Reports a stored origin this build does not recognize, and hands it back
 * unchanged.
 *
 * There is no null branch: the column is `NOT NULL DEFAULT 'user'`, so a
 * row carries a string whatever wrote it.
 */
function reportUnknownOrigin(value: string, id: string): void {
  if (isValidTypeOrigin(value)) return;
  log("error", "stored type origin is not one this build recognizes", {
    table: "types",
    column: "origin",
    row_id: id,
    stored_origin: value,
    // Said explicitly so the line is not read as a fallback having been
    // applied. Nothing is substituted: the value fails every equality the
    // consumers test, which excludes the row from all of them.
    projected_as: null,
  });
}

/** Maps rows to `LoadedType`s, dropping any whose schema will not parse. */
export function toLoadedTypes(rows: readonly TypeRow[]): LoadedType[] {
  const results: LoadedType[] = [];
  for (const row of rows) {
    const parsed = safeJsonParse<TypeSchema | null>(
      row.schema,
      null,
      `types.schema[${row.id}]`,
    );
    if (!parsed) continue;
    reportUnknownOrigin(row.origin, row.id);
    results.push({
      schema: parsed,
      origin: row.origin as LoadedType["origin"],
      ...(row.family !== null && {
        family: row.family as LoadedType["family"],
      }),
      ...(row.owner_connector !== null && {
        owner_connector: row.owner_connector,
      }),
    });
  }
  return results;
}
