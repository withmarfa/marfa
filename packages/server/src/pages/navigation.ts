/**
 * The logic a page's lists, picker and search share between the server, which
 * renders them, and the browser modules, which move through them. It touches
 * no DOM and no Node API, so both can import it.
 */

/** Rows on one page of a list. No list offers more, and none offers "all". */
export const PAGE_SIZE = 10;

/**
 * The item after a step up or down a list, wrapping at both ends. `-1` is
 * "no item yet": down then lands on the first and up on the last.
 */
export function stepIndex(
  current: number,
  delta: 1 | -1,
  length: number,
): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return (current + delta + length) % length;
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Does `haystack` hold every word of `query`, in any order, ignoring case? */
export function matchesQuery(query: string, haystack: string): boolean {
  const lowered = haystack.toLowerCase();
  return words(query).every((word) => lowered.includes(word));
}

/**
 * The indexes of the items that match `query`, those whose title holds the
 * whole query first and the rest in the order given.
 */
export function rankMatches(
  query: string,
  items: readonly { title: string; haystack: string }[],
): number[] {
  const whole = query.trim().toLowerCase();
  const hits: { index: number; inTitle: boolean }[] = [];
  items.forEach((item, index) => {
    if (!matchesQuery(query, item.haystack)) return;
    hits.push({
      index,
      inTitle: whole === "" || item.title.toLowerCase().includes(whole),
    });
  });
  return [...hits]
    .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || a.index - b.index)
    .map((hit) => hit.index);
}

export interface Pagination {
  /** The page shown, from 1. */
  page: number;
  /** The last page, from 1: an empty list is one empty page. */
  last: number;
  /** The offset of the first row shown. */
  from: number;
  /** The offset after the last row shown. */
  to: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/** Where `page` falls in a list of `total` rows, held inside the list. */
export function paginate(
  total: number,
  page: number,
  size: number = PAGE_SIZE,
): Pagination {
  const last = Math.max(1, Math.ceil(total / size));
  const shown = Math.min(Math.max(1, Math.trunc(page)), last);
  const from = (shown - 1) * size;
  return {
    page: shown,
    last,
    from,
    to: Math.min(total, from + size),
    total,
    hasPrevious: shown > 1,
    hasNext: shown < last,
  };
}

/** A page number from a query string: a positive whole number, else the first page. */
export function parsePageNumber(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value)) return 1;
  return Number(value);
}
