/**
 * Dates in the viewer's own time zone. The server writes a date as
 * `<time datetime="2026-10-03T09:30:00.000Z" data-local-date>` with the UTC
 * date as its text, which stands for a browser that does not run the script.
 * This writes that text again as the date where the viewer is, so a passkey
 * added late in the evening is not shown a day early or late.
 */
import { dateFormat } from "../local-date.js";

/** Write each date under `root` in the viewer's time zone. Call it again on markup swapped in later. */
export function localizeDates(root: ParentNode = document): void {
  const format = dateFormat();
  for (const time of root.querySelectorAll<HTMLTimeElement>(
    "time[data-local-date][datetime]",
  )) {
    const at = new Date(time.dateTime);
    if (!Number.isNaN(at.getTime())) time.textContent = format.format(at);
  }
}
