/**
 * The per-item tag bounds.
 *
 * A request naming more than `MAX_TAGS_PER_ITEM` tags is refused, even when
 * its duplicates collapse, and an item may not come to hold more than that
 * many. The stores count the set they write inside the transaction that
 * writes it, because a check made in another transaction bounds nothing when
 * two writes race. A write is refused only when it is over the bound and
 * larger than what the item held, so a row an archive restored over the bound
 * stays writable downward.
 */

/** Largest number of tags one item may hold. */
export const MAX_TAGS_PER_ITEM = 100;

/**
 * Longest tag, in UTF-16 code units. A tag is removed through its own URL
 * path, so one the server's URL limit refuses could be written and never
 * removed.
 */
export const MAX_TAG_LENGTH = 128;

/** An item's tags are a set: each kept once, where it first appears. */
export function distinctTags(tags: readonly string[]): string[] {
  return [...new Set(tags)];
}
