/**
 * The page bound, in one place.
 *
 * It was written out thirteen times: six route schemas, two of their
 * description strings, four storage clamps, and a hand-written
 * re-implementation of the clamp inside a synthetic storage double in a test.
 * Thirteen copies of one number agreed with each other, which is what made the
 * absence of a constant invisible.
 *
 * **The reason this matters is not tidiness.** `ItemStore.list` guards its
 * pagination with `throw new Error("unreachable: hasMore but data is empty")`,
 * and that line is reachable the moment a `limit` of `0` gets through: the
 * clamp is `Math.min(limit ?? 50, MAX)`, `0` is not nullish so the default
 * never fires, `LIMIT 1` comes back with a row, and the page slices to
 * nothing. It has never fired because every one of the thirteen restatements
 * happens to refuse `0` upstream. A comment asserting a line cannot be reached
 * while depending on thirteen separate copies of a number staying correct is
 * the shape this package has spent a delivery removing.
 *
 * `ItemStore.list` now floors at `MIN_PAGE_LIMIT` the way `AuditStore.list`
 * always has, so the guard is honest as well as untriggered.
 *
 * **Edges are deliberately not bounded by this.** Both edge stores use 500,
 * declared beside them, because an edge row is far smaller than an item and
 * the doors that page them say so in their own schemas. A single constant
 * spanning both would be a claim that the two limits are one decision, and
 * they are not.
 */

/** Largest page any item, audit, connector or webhook door will return. */
export const MAX_PAGE_LIMIT = 200;

/** What a door returns when the caller names no limit. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Smallest page a store will resolve to.
 *
 * The route schemas refuse `0` before a handler runs, so this is the floor for
 * callers that reach a store directly — every internal caller today passes a
 * module constant, which is why the item store's zero path had never been
 * reached rather than why it could not be.
 */
export const MIN_PAGE_LIMIT = 1;
