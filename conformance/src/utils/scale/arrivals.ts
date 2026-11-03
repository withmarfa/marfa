/**
 * Matching a change written in one place to the moment it showed in another:
 * a file edit to the server's item, or a server write to a device's copy.
 *
 * A change is found by the marker it carries, never by its position in a
 * list, so changes that arrive out of order, twice or not at all are each
 * judged on their own. Pure, so the matching has tests; the steps do the
 * reading.
 */

export interface Written {
  /** Text unique to this change, found again wherever it arrives. */
  marker: string;
  /** Milliseconds on the clock all readings use, taken as the write finished. */
  wroteAt: number;
}

export interface Reading {
  text: string;
  seenAt: number;
}

export interface Matched {
  /** One per change that arrived, in the order the changes were written. */
  latenciesMs: number[];
  /** The markers of changes that never arrived, in the order written. */
  missing: string[];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True where `marker` stands whole in `text`: `edit-1` is not found in `edit-10`. */
export function holdsMarker(text: string, marker: string): boolean {
  return new RegExp(
    `(?<![A-Za-z0-9])${escape(marker)}(?![A-Za-z0-9])`,
    "u",
  ).test(text);
}

export function matchArrivals(
  written: readonly Written[],
  readings: readonly Reading[],
): Matched {
  const latenciesMs: number[] = [];
  const missing: string[] = [];
  for (const change of written) {
    let first: number | null = null;
    for (const reading of readings) {
      // A reading from before the write cannot be this write's arrival.
      if (reading.seenAt < change.wroteAt) continue;
      if (!holdsMarker(reading.text, change.marker)) continue;
      if (first === null || reading.seenAt < first) first = reading.seenAt;
    }
    if (first === null) missing.push(change.marker);
    else latenciesMs.push(first - change.wroteAt);
  }
  return { latenciesMs, missing };
}
