/**
 * The words the key pages use for when a key was made, last used and ends.
 *
 * Every function takes the time it measures from, so a test names it and the
 * page reads it once. Dates are written in UTC: a page is made on the server,
 * which does not know where the person is.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A key that ends within this many days is one the owner is told about. */
export const ENDING_SOON_DAYS = 7;

const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  day: "numeric",
});

const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  day: "numeric",
  year: "numeric",
});

/** "October 24", with the year when it is more than about ten months away. */
export function dateWords(at: number, now: number): string {
  return (
    Math.abs(at - now) > 300 * DAY_MS ? MONTH_DAY_YEAR : MONTH_DAY
  ).format(at);
}

const count = (n: number, unit: string): string =>
  `${String(n)} ${unit}${n === 1 ? "" : "s"}`;

/** When a key ends from `now`, as a sentence: "Never ends", "Ends tomorrow", "Ends October 30". */
export function endsWords(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "Never ends";
  const left = expiresAt - now;
  if (left <= 0) return "Ended";
  if (left < DAY_MS) return "Ends today";
  if (left < 2 * DAY_MS) return "Ends tomorrow";
  if (left < 14 * DAY_MS)
    return `Ends in ${count(Math.floor(left / DAY_MS), "day")}`;
  return `Ends ${dateWords(expiresAt, now)}`;
}

/** Whether a key ends soon enough to need a look. */
export function endsSoon(expiresAt: number | null, now: number): boolean {
  return (
    expiresAt !== null &&
    expiresAt - now > 0 &&
    expiresAt - now < ENDING_SOON_DAYS * DAY_MS
  );
}

/** The title Needs attention gives a key that ends soon. */
export function endingTitle(
  label: string,
  expiresAt: number,
  now: number,
): string {
  const left = expiresAt - now;
  const when =
    left < DAY_MS
      ? "today"
      : left < 2 * DAY_MS
        ? "tomorrow"
        : `in ${count(Math.floor(left / DAY_MS), "day")}`;
  return `Key ${label} ends ${when}`;
}

/** The right end of a key's row: "Never used", "Used 3 hours ago", "Used on March 2". */
export function usedWords(lastUsedAt: number | null, now: number): string {
  if (lastUsedAt === null) return "Never used";
  const ago = now - lastUsedAt;
  if (ago < MINUTE_MS) return "Used just now";
  if (ago < HOUR_MS)
    return `Used ${count(Math.floor(ago / MINUTE_MS), "minute")} ago`;
  if (ago < DAY_MS)
    return `Used ${count(Math.floor(ago / HOUR_MS), "hour")} ago`;
  if (ago < 2 * DAY_MS) return "Used yesterday";
  if (ago < 30 * DAY_MS)
    return `Used ${count(Math.floor(ago / DAY_MS), "day")} ago`;
  return `Used on ${dateWords(lastUsedAt, now)}`;
}

/** The last-used row on a key's own page: the same, without the leading "Used". */
export function lastUsedValue(lastUsedAt: number | null, now: number): string {
  if (lastUsedAt === null) return "Never";
  const words = usedWords(lastUsedAt, now);
  const rest = words.replace(/^Used /, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** When a key was made: "Just now" within the minute, else the date. */
export function createdWords(createdAt: number, now: number): string {
  return now - createdAt < MINUTE_MS ? "Just now" : dateWords(createdAt, now);
}
