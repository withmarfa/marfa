import { ErrorCode, MarfaError, hasBoundedLifecycle } from "@withmarfa/shared";

/**
 * `tier` is a server-owned field on `system.*` rows, and every door that
 * writes an item has to say so identically.
 *
 * Create rejected a caller-supplied tier on a `system.*` type; the update
 * doors accepted one. That asymmetry is the same shape as the write-door
 * defects this file's neighbors exist to prevent: one surface enforcing
 * something its siblings do not, with nothing asserting they agree.
 *
 * It lives here rather than inline at each door because fixing it on one
 * door would have created a fresh disagreement of exactly the kind being
 * closed. One rule, called from all of them.
 *
 * There is no exception: no server path stamps a `feed` tier on a
 * `system.*` row, and every door refuses a client that asks for one.
 *
 * **Which types this applies to is `hasBoundedLifecycle`, not the seeded set
 * alone.** The set and the `system.` name test answer differently for a type
 * named into the reserved root that this build did not seed, and asking only
 * the set let such a type accept a caller-supplied tier here while the delete
 * door put it into the bounded lifecycle's terminal state. Two doors
 * disagreeing about what a platform record is, which is the disagreement this
 * file exists to prevent one level down.
 */
export function assertTierApplicable(
  type: string | undefined,
  tier: unknown,
): void {
  if (tier === undefined) return;
  if (type === undefined) return;
  if (!hasBoundedLifecycle(type)) return;
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    "tier is not applicable to system.* items",
    { field: "tier" },
  );
}
