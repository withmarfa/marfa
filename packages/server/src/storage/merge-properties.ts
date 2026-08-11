import { coerceNullProperties } from "@withmarfa/shared";

/**
 * How an update's properties merge into a row's, in one place.
 *
 * Both dialect stores perform this merge, and the natural-key upsert route
 * has to predict it: a re-sync is judged on the value the row ends up with,
 * not on the body, because a body naming no required field at all can still
 * be what removes one. Three copies of a merge rule is three chances to
 * disagree, and two had already drifted — the SQLite store resolved the type
 * without a space, so a null on a space-registered custom type's optional
 * field was written as null there and dropped on Postgres.
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

/** The properties the row ends up holding, given the resolved incoming set. */
export function mergeUpdateProperties(
  current: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined,
  nullClears: boolean,
): Record<string, unknown> {
  if (incoming === undefined) return current;
  const shallow = { ...current, ...incoming };
  if (!nullClears) return shallow;
  // Faithful-mirror re-sync: a key the upstream cleared is dropped rather
  // than surviving as a stale value.
  return Object.fromEntries(
    Object.entries(shallow).filter(([key]) => incoming[key] !== null),
  );
}
