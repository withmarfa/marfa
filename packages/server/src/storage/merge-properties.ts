import { coerceNullProperties } from "@withmarfa/shared";

/**
 * How an update's properties merge into a row's, in one place.
 *
 * The item store performs this merge, and the natural-key upsert route has
 * to predict it: a re-sync is judged on the value the row ends up with, not
 * on the body, because a body naming no required field at all can still be
 * what removes one. Two copies of a merge rule is two chances to disagree,
 * and they had already drifted once — the store resolved the type without a
 * space, so a null on a space-registered custom type's optional field was
 * written as null.
 */

/**
 * What the caller's properties mean before they meet the row.
 *
 * Without faithful-mirror semantics a null on an optional field means
 * "leave unset", matching the create path, so it is dropped here rather than
 * overwriting a stored value. A null on a required field is preserved so
 * validation still rejects it. `undefined` in means the update names no
 * properties at all, which is distinct from naming an empty set.
 */
export function resolveIncomingProperties(
  typeId: string,
  properties: Record<string, unknown> | undefined,
  nullClears: boolean,
  spaceId?: string | null,
): Record<string, unknown> | undefined {
  if (properties === undefined) return undefined;
  return nullClears
    ? properties
    : coerceNullProperties(typeId, properties, spaceId);
}

/**
 * The properties the row ends up holding, given the resolved incoming set.
 *
 * `replace` is for a caller that means the incoming set to BE the row's
 * properties rather than to be laid over them. The clearing behaviour is
 * reachable without it — an owning integration's re-sync already has a null
 * delete a key — but only by naming every field it wants gone, which means
 * every call site keeping its own list of the fields it is not sending. Nine
 * such lists is nine chances to miss one, and the tenth site written after
 * them starts from nothing. Stating the intent once is the same rule that
 * keeps any coherent state on one mechanism rather than on every caller
 * remembering.
 *
 * A replace still validates: the resulting set has to satisfy the type, so
 * dropping a required field is refused rather than written.
 */
export function mergeUpdateProperties(
  current: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined,
  nullClears: boolean,
  mode: "merge" | "replace" = "merge",
): Record<string, unknown> {
  if (incoming === undefined) return current;
  if (mode === "replace") {
    // A null still means "not present" rather than a stored null, so the
    // two ways of asking for a key to be gone agree.
    return Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => value !== null),
    );
  }
  const shallow = { ...current, ...incoming };
  if (!nullClears) return shallow;
  // Faithful-mirror re-sync: a key the upstream cleared is dropped rather
  // than surviving as a stale value.
  return Object.fromEntries(
    Object.entries(shallow).filter(([key]) => incoming[key] !== null),
  );
}
