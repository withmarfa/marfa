/**
 * Whether a query should exclude the reserved `system.*` namespace.
 *
 * Platform-internal rows are kept out of an ordinary query by default and
 * opted back in two ways: an explicit token, or a `type` filter naming the
 * namespace, since a caller asking for `system.credential` has already said
 * what it wants and refusing it would answer a different question.
 *
 * **It is a function because it was a sentence.** `GET /items` and
 * `GET /search` each wrote the rule out, identically, and
 * `POST /items/bulk-actions` did not write it at all — so the bulk door
 * matched platform-internal rows its sibling read hides, a dry run
 * enumerated them, and the actions that follow acted on what it enumerated.
 * Two copies and one omission is the shape a third copy would have
 * continued.
 *
 * **The name test is right here for a reason worth knowing, because the
 * neighbouring file says it is usually wrong.** `_tier-rules.ts` imports
 * `hasBoundedLifecycle` rather than asking whether an id starts with
 * `system.`, and that helper's own docblock warns that the two are
 * equivalent only while every reserved type happens to ship under that
 * prefix. What makes the name test correct rather than lucky here is that
 * the exclusion this feeds is compiled to `type NOT LIKE 'system.%'` in
 * SQL. A boot-filled set is not expressible in that predicate, so a route
 * check consulting one would let the opt-in and the exclusion disagree
 * about the same row. The route predicate has to be the column predicate.
 *
 * **What this is not.** On the two read doors it shapes an unnarrowed query
 * and permissions decide the rest: a credential still has to hold the type,
 * and the platform-credential gate still decides who may write there. On
 * `POST /items/bulk-actions` that is not true — it runs no per-row
 * `requireTypeAccess`, so nothing stands between a match set and the action
 * taken on it except what narrowed the query. The type filter beside this
 * cannot cover for that: a credential granted write across the board
 * satisfies it and is still not a platform credential. So on that door this
 * is the whole of the reserved-namespace control rather than one layer of
 * it, which is the reason it takes no widening token: a read widened by one
 * answers a bigger question, an action widened by one acts on more rows.
 *
 * `POST /items/bulk-get` is deliberately not a caller. It resolves a
 * caller's own id list rather than running a query, so it filters the rows
 * it fetched rather than narrowing SQL, and the decision it makes is the
 * same while the mechanism is not.
 */

/** The token a caller passes to `include` to widen a query to `system.*`. */
export const SYSTEM_INCLUDE_TOKEN = "system";

/**
 * True when the query must exclude `system.*`.
 *
 * `typeFilter` is the request's own `type` parameter, whatever the door
 * calls it.
 */
export function excludesSystemTypes(
  includeTokens: ReadonlySet<string>,
  typeFilter: string | undefined,
): boolean {
  if (includeTokens.has(SYSTEM_INCLUDE_TOKEN)) return false;
  return !namesSystemNamespace(typeFilter);
}

/**
 * True when a `type` filter reaches into the reserved namespace on its own.
 *
 * Exported because the bulk-action door has no `include` parameter to widen
 * with, so the type filter is its only opt-in and it asks this directly.
 *
 * **What counts as naming it depends on the door, and this function is the
 * looser half.** It accepts a wildcard inside the namespace, because the two
 * read doors validate their `type` with `isValidTypePattern` and so can be
 * handed one. The bulk-action door validates with `isValidTypeIdentifier`,
 * which refuses a wildcard outright, so there the opt-in is a concrete
 * reserved type and `system.*` is a `400` rather than a widening. That is
 * the narrower door and it is the right one for a door that writes, but it
 * means a caller acting across several reserved types names them one call
 * at a time.
 */
export function namesSystemNamespace(typeFilter: string | undefined): boolean {
  return typeof typeFilter === "string" && typeFilter.startsWith("system.");
}
