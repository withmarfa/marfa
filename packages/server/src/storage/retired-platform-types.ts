/**
 * Which shipped types this instance still carries that the build no longer
 * names: the retired platform types.
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
 * **Derived, never stored.** The retired set is a pure function of the build and the
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
 * runtime registration, or a restored row nobody recorded, is not the
 * build's to have an opinion about and must never be caught here.
 */
export function computeRetiredPlatformTypes(
  shipped: readonly SeededPlatformType[],
  loaded: readonly LoadedType[],
): string[] {
  const shippedIds = new Set(shipped.map((s) => s.schema.id));
  const retired = new Set<string>();
  for (const row of loaded) {
    if (row.origin !== "platform") continue;
    if (shippedIds.has(row.schema.id)) continue;
    retired.add(row.schema.id);
  }
  return [...retired].sort();
}

let retiredIds: readonly string[] = [];

/**
 * Record what this boot found. Called once, after the seed has run and the
 * rows have been read, on the same pass that fills the registry.
 */
export function setRetiredPlatformTypes(ids: readonly string[]): void {
  retiredIds = [...ids];
}

/**
 * Take one identifier out of what this boot found, once its row is gone.
 *
 * Still derived and never stored: this only keeps the in-memory set true to
 * the rows between boots, and the next boot recomputes it from the rows
 * either way. Call it after the delete has committed, never inside the
 * transaction, so a rolled-back delete leaves the type listed.
 */
export function forgetRetiredPlatformType(id: string): void {
  retiredIds = retiredIds.filter((retired) => retired !== id);
}

/**
 * What this boot found. Empty until a boot records something, which is the
 * honest answer for a process that has not looked: a fresh instance and an
 * instance mid-boot both genuinely know of no retired type.
 */
export function retiredPlatformTypes(): readonly string[] {
  return retiredIds;
}
