/**
 * The words the key pages use for when a key was made, last used and ends.
 *
 * Every function takes the time it measures from, so a test names it and the
 * page reads it once. Dates are written in UTC: a page is made on the server,
 * which does not know where the person is. Days are UTC calendar days, so a key
 * that ends ten minutes after midnight ends tomorrow, not today.
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

/** How many UTC calendar days `to` is after `from`: 1 for 00:10 tomorrow seen from 23:50 tonight. */
const daysBetween = (from: number, to: number): number =>
  Math.floor(to / DAY_MS) - Math.floor(from / DAY_MS);

/** "today", "tomorrow" or "in 3 days": the calendar days from `now` to a time after it. */
function whenWords(expiresAt: number, now: number): string {
  const days = daysBetween(now, expiresAt);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${count(days, "day")}`;
}

/** When a key ends from `now`, as a sentence: "Never ends", "Ends tomorrow", "Ends October 30". */
export function endsWords(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "Never ends";
  if (expiresAt - now <= 0) return "Ended";
  if (daysBetween(now, expiresAt) < 14)
    return `Ends ${whenWords(expiresAt, now)}`;
  return `Ends ${dateWords(expiresAt, now)}`;
}

/** Whether a key ends soon enough to need a look: before the seventh calendar day out. */
export function endsSoon(expiresAt: number | null, now: number): boolean {
  return (
    expiresAt !== null &&
    expiresAt - now > 0 &&
    daysBetween(now, expiresAt) < ENDING_SOON_DAYS
  );
}

/** The title Needs attention gives a key that ends soon. */
export function endingTitle(
  label: string,
  expiresAt: number,
  now: number,
): string {
  return `Key ${label} ends ${whenWords(expiresAt, now)}`;
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
  const days = daysBetween(lastUsedAt, now);
  if (days === 1) return "Used yesterday";
  if (days < 30) return `Used ${count(days, "day")} ago`;
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

/** When something happened, for a row that lists many: "Just now", "3 hours ago", "Yesterday", "October 3". */
export function happenedWords(at: number, now: number): string {
  const ago = now - at;
  if (ago < MINUTE_MS) return "Just now";
  if (ago < HOUR_MS)
    return `${count(Math.floor(ago / MINUTE_MS), "minute")} ago`;
  if (ago < DAY_MS) return `${count(Math.floor(ago / HOUR_MS), "hour")} ago`;
  const days = daysBetween(at, now);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${count(days, "day")} ago`;
  return dateWords(at, now);
}
