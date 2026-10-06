import { coerceNullProperties } from "@withmarfa/shared";

/**
 * How an update's properties merge into a row's, in one place.
 *
 * The item store performs this merge, and the natural-key upsert route has
 * to predict it: a re-sync is judged on the value the row ends up with, not
 * on the body, because a null kept on a required field shows only there.
 * Two copies of a merge rule is two chances to disagree.
 */

/**
 * What the caller's properties mean before they meet the row.
 *
 * A null on an optional field means "leave unset", matching the create
 * path, so it is dropped here rather than overwriting a stored value. A null
 * on a required field is preserved so validation still rejects it.
 * `undefined` in means the update names no properties at all, which is
 * distinct from naming an empty set.
 */
export function resolveIncomingProperties(
  typeId: string,
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (properties === undefined) return undefined;
  return coerceNullProperties(typeId, properties);
}

/**
 * The properties the row ends up holding, given the resolved incoming set.
 *
 * `replace` is for a caller that means the incoming set to BE the row's
 * properties rather than to be laid over them: a field it leaves out is
 * cleared. Stating that intent once keeps the type's shape out of every
 * call site that would otherwise name each field it wants gone.
 *
 * A replace still validates: the resulting set has to satisfy the type, so
 * dropping a required field is refused rather than written. This is the
 * write at the current version; at a stale one the store merges the caller's
 * genuine changes, a cleared field included, against the ancestor instead.
 */
export function mergeUpdateProperties(
  current: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined,
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
  return { ...current, ...incoming };
}

/**
 * A created item's properties in the order every read answers them
 * (`items.md` 46): the fields the type declares, in the order its read lists
 * them, then every other property in the order the write sent it.
 *
 * Validation answers the fields every type takes ahead of the type's own,
 * which no read of the type lists, so the order is taken from the type and the
 * write rather than from validation. Built by `Object.fromEntries`, which keeps
 * a property named `__proto__` as a property.
 */
export function inAnswerOrder(
  declared: readonly string[],
  properties: Record<string, unknown>,
  sent: Record<string, unknown>,
): Record<string, unknown> {
  const has = (key: string) =>
    Object.prototype.hasOwnProperty.call(properties, key);
  const order = [
    ...declared.filter(has),
    ...Object.keys(sent).filter((key) => has(key) && !declared.includes(key)),
  ];
  const placed = new Set(order);
  order.push(...Object.keys(properties).filter((key) => !placed.has(key)));
  return Object.fromEntries(order.map((key) => [key, properties[key]]));
}
