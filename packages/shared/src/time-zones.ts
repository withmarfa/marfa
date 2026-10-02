/**
 * Converting between an instant and the wall clock a zone reads it at.
 *
 * Stored times are instants. A zone is what turns one into the reading a
 * person sees, and a whole day is the case where only that reading exists:
 * a day has no instant, so the calendar date has to come from the event's
 * own zone every time and never from whoever happens to be looking. Deriving
 * it in the reader's zone is what puts a birthday a day early for everyone
 * west of the event.
 *
 * `Intl` is the zone database rather than a table of offsets, because it is
 * the only one every runtime here ships and the only one that knows when a
 * transition happened. Web-safe: this package runs in browsers and Workers.
 */

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Formatter construction dominates the cost of an offset lookup, and one
 *  calendar read asks about the same zone thousands of times. */
function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(zone, formatter);
  }
  return formatter;
}

/** The offset, in minutes, that `zone` was at for the given instant. */
export function zoneOffsetMinutes(instant: Date, zone: string): number {
  const parts = zoneFormatter(zone).formatToParts(instant);
  const at = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // `hour12: false` renders midnight as 24 in some engines.
  const hour = at("hour") % 24;
  const asUtc = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    hour,
    at("minute"),
    at("second"),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The instant at which `zone` reads the given wall clock, where the wall
 * clock is carried in a Date's UTC fields.
 *
 * Inside a clock change there is no single answer, and RFC 5545 (section
 * 3.3.5) fixes one: a reading the change skips is read with the offset in
 * force before the gap, so it lands later by the length of the gap, and a
 * reading the change repeats names its first occurrence. The offsets a day
 * either side are the two candidates; no zone changes its clocks twice
 * within a day.
 */
export function wallClockToInstant(wall: Date, zone: string | undefined): Date {
  if (!zone) return wall;
  const w = wall.getTime();
  const before = zoneOffsetMinutes(new Date(w - 86_400_000), zone) * 60_000;
  const after = zoneOffsetMinutes(new Date(w + 86_400_000), zone) * 60_000;
  const candidates = [before, after]
    .filter(
      (offset) =>
        zoneOffsetMinutes(new Date(w - offset), zone) * 60_000 === offset,
    )
    .map((offset) => w - offset);
  if (candidates.length === 0) return new Date(w - before);
  return new Date(Math.min(...candidates));
}

/**
 * Render an instant as the wall-clock reading it has in `zone`, carried in a
 * Date's UTC fields.
 *
 * Exact, unlike the inverse: the offset at a known instant is unambiguous,
 * so no correction pass is needed.
 */
export function instantToWallClock(
  instant: Date,
  zone: string | undefined,
): Date {
  if (!zone) return instant;
  return new Date(
    instant.getTime() + zoneOffsetMinutes(instant, zone) * 60_000,
  );
}

/** `YYYY-MM-DD` from a Date's UTC fields. */
function utcDatePart(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The instant at which a whole day starts, for a day named as `YYYY-MM-DD`
 * in `zone`.
 *
 * A day is not an instant, so storing one means choosing where it starts.
 * Midnight in the event's own zone is the only choice that survives the
 * round trip: rendering that instant back in the same zone returns the same
 * date, in every zone, which midnight UTC does not — for anywhere west of
 * Greenwich it lands on the evening before.
 *
 * Returns `null` when the input is not a bare date, so a caller can tell a
 * malformed value from a legitimate one rather than storing a silent NaN.
 */
export function dateInZoneToInstant(
  date: string,
  zone: string | undefined,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const wall = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(wall.getTime())) return null;
  return wallClockToInstant(wall, zone).toISOString();
}

/**
 * The calendar date an instant falls on, read in `zone`.
 *
 * The inverse of `dateInZoneToInstant`, and the only way a reader should
 * derive an all-day event's date. Never uses the caller's own zone: two
 * people looking at one whole-day event have to see one day.
 */
export function instantToDateInZone(
  instant: string,
  zone: string | undefined,
): string | null {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return null;
  return utcDatePart(instantToWallClock(parsed, zone));
}
