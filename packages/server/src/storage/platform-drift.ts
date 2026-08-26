/**
 * Which shipped types this instance still carries that the build no longer
 * names.
 *
 * The platform vocabulary is seeded into rows and the registry is filled
 * from the rows, and the seed is an upsert with no prune. So deleting a
 * type's JSON removes it from a fresh instance and from no existing one:
 * the row stays, keeps resolving, and the immutability gate refuses to
 * delete it because everything in the platform set is locked. The
 * identifier outlives the code that shipped it, permanently, and nothing
 * says so.
 *
 * **This reports and does not delete, which is the whole design.**
 *
 * A prune beside the seed would fire hardest exactly when the build is
 * wrong. The shipped set is a committed generated array, so a partial
 * deploy cannot ship fewer types, it is all or nothing with the bundle,
 * and the realistic population is a rollback, which is routine. There a
 * prune would delete rows the older build simply does not know about, on
 * every container, on every restart, with no operator present. An upsert
 * survives all of that because re-adding a row is recoverable and removing
 * one is not.
 *
 * `platform-family.ts` took the same decision twenty lines from where a
 * boot prune would live: it projects an unreadable row rather than
 * refusing, and names rollback as the reason.
 *
 * **Derived, never stored.** Drift is a pure function of the build and the
 * rows, recomputed at every boot. A stored flag would be a second source of
 * truth with nothing keeping it honest, and it would go stale in precisely
 * the case that matters: a rollback, where the flag was written by a build
 * that is no longer running.
 */
import type { SeededPlatformType } from "@withmarfa/shared";
import type { LoadedType } from "./interface.js";

/**
 * Platform rows this build does not ship, by identifier, sorted.
 *
 * Scoped to `origin === "platform"` rather than to family or namespace: a
 * space's own registrations are not the build's to have an opinion about,
 * and a travelling integration type is registered into a space overlay
 * under `origin = "integration"` and must never be caught here.
 */
export function computePlatformDrift(
  shipped: readonly SeededPlatformType[],
  loaded: readonly LoadedType[],
): string[] {
  const shippedIds = new Set(shipped.map((s) => s.schema.id));
  const drifted = new Set<string>();
  for (const row of loaded) {
    if (row.origin !== "platform") continue;
    // Scoped to the bucket the seed writes, which is the same pair the
    // removal is scoped to. Reporting a row the removal cannot reach would
    // put an instance in a state with no way out: degraded forever, with
    // the only remedy answering not-found. The two scopes have to be the
    // same scope or the report is not a report of anything actionable.
    if (row.space_id !== "") continue;
    if (shippedIds.has(row.schema.id)) continue;
    drifted.add(row.schema.id);
  }
  return [...drifted].sort();
}

let driftedIds: readonly string[] = [];

/**
 * Record what this boot found. Called once, after the seed has run and the
 * rows have been read, on the same pass that fills the registry.
 */
export function setPlatformDrift(ids: readonly string[]): void {
  driftedIds = [...ids];
}

/**
 * What this boot found. Empty until a boot records something, which is the
 * honest answer for a process that has not looked: a self-hoster's fresh
 * instance and an instance mid-boot both genuinely know of no drift.
 */
export function platformDrift(): readonly string[] {
  return driftedIds;
}
