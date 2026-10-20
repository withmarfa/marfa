/**
 * How a date is written on a page. The server writes it in UTC; the browser
 * writes it again in the viewer's own time zone (`client/local-date.ts`). It
 * touches no DOM and no Node API, so both can import it.
 */

/** The date as "October 3, 2026", in `timeZone`, or the viewer's own where none is named. */
export function dateFormat(timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
