/**
 * Walking a cursor-paginated endpoint, written once.
 *
 * Every paginated endpoint answers with the same three fields, so the loop
 * that drains one is the same loop every time. It had been hand-written in
 * five places across the consumer apps and a sixth inside this package's own
 * replica, each copy differing only in what it accumulated into. They agreed
 * on the terminal condition, which is the good case: the copy that did not
 * agree stopped at a fixed page count and returned a truncated set that read
 * exactly like a complete one.
 *
 * Two entry points, split by where the cost lands rather than by taste:
 *
 * - `paginate` streams. A consumer handling rows as they arrive holds one page
 *   at a time, so there is nothing to bound; it stops when the server says
 *   there is no more, and a caller that breaks early simply stops fetching.
 * - `collect` accumulates into an array, so the caller says how many rows it
 *   is prepared to hold. There is no default ceiling, because a limit nobody
 *   chose is a limit nobody notices.
 *
 * Exceeding the ceiling throws rather than truncating. A silently truncated
 * walk is indistinguishable from a complete one at the call site, which is the
 * failure this helper exists to stop repeating.
 */

import type { PaginatedResult } from "@withmarfa/shared";

/**
 * Fetch one page. `cursor` is `undefined` for the first call and thereafter
 * carries whatever the previous page returned.
 */
export type PageFetcher<T> = (
  cursor: string | undefined,
) => Promise<PaginatedResult<T>>;

/** Options for `collect`. */
export interface CollectOptions {
  /**
   * Most rows to accumulate. Required: the point of the ceiling is that
   * somebody chose it. Producing more throws `PageLimitExceededError`.
   */
  maxItems: number;
}

/** A `collect` walk produced more rows than the caller allowed. */
export class PageLimitExceededError extends Error {
  readonly maxItems: number;

  constructor(maxItems: number) {
    super(
      `Paginated walk produced more than maxItems=${String(maxItems)}. Raise the ceiling if the result set is genuinely this large, or use paginate() and handle rows as they arrive.`,
    );
    this.name = "PageLimitExceededError";
    this.maxItems = maxItems;
  }
}

/**
 * Yield every row a paginated endpoint will return, one page at a time.
 *
 * ```ts
 * for await (const item of paginate((cursor) =>
 *   client.items.list({ type: "core.note", limit: 100, cursor }),
 * )) {
 *   // one row at a time; only the current page is held
 * }
 * ```
 */
export async function* paginate<T>(
  fetchPage: PageFetcher<T>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    for (const row of page.data) yield row;
    // Both conditions matter. `has_more` false ends the walk; a page that
    // claims more but carries no cursor has nothing to resume from, and
    // re-requesting the previous cursor would serve the same page forever.
    if (!page.has_more || !page.cursor) return;
    cursor = page.cursor;
  }
}

/**
 * Drain a paginated walk into an array, up to a ceiling the caller names.
 *
 * ```ts
 * const notes = await collect(client.items.listAll({ type: "core.note" }), {
 *   maxItems: 5_000,
 * });
 * ```
 */
export async function collect<T>(
  source: AsyncIterable<T>,
  options: CollectOptions,
): Promise<T[]> {
  const { maxItems } = options;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new RangeError(
      `collect() needs a positive integer maxItems, got ${String(maxItems)}`,
    );
  }

  const out: T[] = [];
  for await (const row of source) {
    if (out.length >= maxItems) throw new PageLimitExceededError(maxItems);
    out.push(row);
  }
  return out;
}
