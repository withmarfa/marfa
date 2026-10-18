/**
 * The restore drill's pure piece, kept apart from the script so the offline
 * lane can hold it: the comparison every verdict rests on.
 */

/** Whether two values are the same, as JSON: what every "same" line in
 *  the drill's report means. */
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
