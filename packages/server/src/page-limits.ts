import { z } from "@hono/zod-openapi";

/**
 * The page bound, in one place, so every route schema, description and
 * storage clamp reads the same number.
 *
 * **The floor is load-bearing.** `ItemStore.list` guards its pagination with
 * `throw new Error("unreachable: hasMore but data is empty")`, and a `limit`
 * of `0` would reach it: `Math.min(limit ?? 50, MAX)` lets `0` through, one
 * row comes back and the page slices to nothing. `ItemStore.list` and
 * `AuditStore.list` floor at `MIN_PAGE_LIMIT`, so the guard holds whatever
 * a route admits.
 *
 * **Edges are deliberately not bounded by this.** The edge store pages at
 * 500, declared beside it, because an edge row is far smaller than an item
 * and the doors that page them say so in their own schemas. One constant
 * spanning both would claim the two limits are one decision, and they are
 * not.
 */

/** Largest page any item, audit, connector or webhook door will return. */
export const MAX_PAGE_LIMIT = 200;

/** What a door returns when the caller names no limit. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Smallest page a store will resolve to.
 *
 * The route schemas refuse `0` before a handler runs, so this is the floor for
 * callers that reach a store directly, where no schema stands in front of the
 * limit and nothing else stops a `0` reaching the guard described above.
 */
export const MIN_PAGE_LIMIT = 1;

const LIMIT_DESCRIPTION = "The maximum number of results to return.";

const CURSOR_DESCRIPTION =
  "The `next_cursor` from the previous page. Leave it out to get the first page.";

/**
 * The `limit` query parameter of a paginated route, described the same way
 * everywhere. A route that names no `default` leaves the page size to its
 * handler.
 */
export function pageLimit(options: {
  max: number;
  default: number;
}): ReturnType<typeof limitWithDefault>;
export function pageLimit(options: {
  max: number;
}): ReturnType<typeof limitWithoutDefault>;
export function pageLimit(options: { max: number; default?: number }) {
  return options.default === undefined
    ? limitWithoutDefault(options.max)
    : limitWithDefault(options.max, options.default);
}

function limitWithDefault(max: number, fallback: number) {
  return z.coerce
    .number()
    .int()
    .min(MIN_PAGE_LIMIT)
    .max(max)
    .default(fallback)
    .describe(LIMIT_DESCRIPTION);
}

function limitWithoutDefault(max: number) {
  return z.coerce
    .number()
    .int()
    .min(MIN_PAGE_LIMIT)
    .max(max)
    .optional()
    .describe(LIMIT_DESCRIPTION);
}

/** The `cursor` query parameter of a paginated route. */
export function pageCursor() {
  return z.string().optional().describe(CURSOR_DESCRIPTION);
}
