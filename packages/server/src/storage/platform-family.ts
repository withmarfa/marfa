/**
 * Projects the platform rows an instance holds onto the seeded set the
 * registry is filled from, placing a row this build cannot read at the
 * restrictive end rather than the permissive one.
 *
 * The family is not a label. `seedPlatformTypes` puts every shipped schema in
 * the registry and then uses the family to decide whether the id joins
 * `SYSTEM_TYPE_IDS`, which rejects a caller-supplied `tier` and pins the type
 * to the bounded `active`/`revoked` lifecycle. `core` misses that set, so
 * `family: row.family ?? "core"` reads as reasonable and is the most
 * permissive answer available: a device or app row whose family could
 * not be read would get the three-state lifecycle and an open `tier`, and a
 * delete would soft-delete it to `trashed`, a state the system lifecycle has
 * no transition to and default listings hide.
 *
 * **What this does not do.** Family decides no permission category. The
 * reserved-namespace write gate reads `classifyNamespace`, which is the first
 * segment of the identifier and nothing else, and the consent bundles group
 * on the same function. A row that loses its family does not become readable
 * or writable by anyone new, and a log line saying it did would send
 * whoever met it hunting a permissions failure that is not there.
 *
 * **Why this projects rather than refusing to boot.** `seedPlatformTypes`
 * upserts a family for every shipped id immediately before these rows are
 * read back, so a shipped type cannot reach here unplaceable. Everything
 * that can is a platform row the current build does not ship: a retired type
 * the seed deliberately leaves registered so existing items keep resolving,
 * or a row written by a newer build and met by an older one after a
 * rollback. Refusing to start would make that rollback impossible to
 * complete, from a server that cannot come up to be repaired, over a type
 * nothing is using. A boot refusal is the right severity for a corrupt
 * shipped set and the wrong severity for this.
 *
 * So the rule is the one its sibling projections take: recognize, or fall
 * back to the least capability and say so loudly enough that the fallback is
 * never mistaken for a real value.
 */
import {
  isPlatformTypeFamily,
  type PlatformTypeFamily,
  type SeededPlatformType,
} from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import type { LoadedType } from "./interface.js";

/**
 * The family an unplaceable platform row is treated as.
 *
 * `system` because it is the restrictive end of both things family
 * decides: the bounded lifecycle, and a refused `tier`. Worth saying because
 * it reads like the opposite — `system` sounds like the privileged end, and
 * the name is not a statement about what a credential may do with it.
 */
const UNPLACEABLE_FALLBACK: PlatformTypeFamily = "system";

/**
 * The platform rows, as the seeded set, with anything unreadable pinned
 * down rather than let through as ordinary content.
 */
export function projectPlatformRows(
  loaded: readonly LoadedType[],
): SeededPlatformType[] {
  const rows: SeededPlatformType[] = [];

  for (const row of loaded) {
    // Scoped to platform rows, and the scope is load-bearing rather than
    // incidental: a `user` row has no platform family and never had one.
    // Read as "a row with no family is wrong", which is how the rule
    // sounds stated in the abstract, this would pin every type a person
    // registered to a lifecycle they did not choose.
    if (row.origin !== "platform") continue;

    // Recognized, not merely present. Absence is one way a build cannot
    // read this column; a value written by a newer build is the other, and
    // only the first is caught by testing for undefined.
    if (isPlatformTypeFamily(row.family)) {
      rows.push({ schema: row.schema, family: row.family });
      continue;
    }

    log("error", "platform type carries no family this build recognizes", {
      table: "types",
      column: "family",
      row_id: row.schema.id,
      stored_family:
        typeof row.family === "string" ? row.family : typeof row.family,
      projected_as: UNPLACEABLE_FALLBACK,
    });
    rows.push({ schema: row.schema, family: UNPLACEABLE_FALLBACK });
  }

  return rows;
}
