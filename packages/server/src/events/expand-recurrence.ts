/**
 * Read-time expansion of a recurring event series.
 *
 * A series is one item carrying its rule. Occurrences are computed over
 * the window a caller asks for and never materialize into storage, so a
 * rule that runs forever costs nothing until somebody asks about a
 * bounded stretch of time.
 *
 * Two things make this harder than iterating a rule:
 *
 * Wall clock, not instants. "Weekly at 09:00" means 09:00 as the calendar
 * shows it, on both sides of a daylight-saving transition, which is a
 * different number of elapsed hours apart. So the rule is expanded in
 * floating time and each result is anchored to an instant afterwards
 * using the series' own zone. Expanding in UTC instead would silently
 * shift every occurrence by an hour for half the year.
 *
 * Exceptions. A moved or edited instance is stored as its own item
 * naming the occurrence it replaces. It shadows that occurrence: the
 * computed one disappears and the stored item takes its place, at the
 * stored item's own times, which may fall outside the window the
 * computed occurrence sat in.
 */
import ICAL from "ical.js";

export interface RecurrenceSeries {
  /** Item id of the series. */
  id: string;
  /** Wall-clock start, ISO 8601. */
  starts_at: string;
  /** Wall-clock end, ISO 8601. Optional; absent means a zero-length event. */
  ends_at?: string;
  /** IANA zone the wall-clock times are expressed in. */
  timezone?: string;
  /** RFC 5545 property lines: RRULE, RDATE, EXDATE. */
  recurrence: string[];
}

export interface RecurrenceException {
  /** Item id of the stored exception. */
  id: string;
  /** The start of the occurrence this replaces, ISO 8601. */
  original_starts_at: string;
}

export interface Occurrence {
  /** The series this came from. */
  series_id: string;
  /** Start instant, ISO 8601 UTC. */
  starts_at: string;
  /** End instant, ISO 8601 UTC. Absent when the series carries no end. */
  ends_at?: string;
  /** The item to show: the series for a computed occurrence, the stored
   *  item for one an exception replaced. */
  item_id: string;
  /** Set when an exception shadows this occurrence. */
  replaces?: string;
}

/**
 * Ceiling on how many occurrences one series may contribute to a single
 * window. A daily rule over the maximum window is ~400; anything past
 * this is a per-minute rule or a malformed one, and the caller is told
 * rather than handed a silently short list.
 */
export const MAX_OCCURRENCES_PER_SERIES = 2000;

export class RecurrenceExpansionError extends Error {}

/**
 * The offset, in minutes, that `zone` was at for the given instant.
 *
 * Derived by asking Intl to render the instant in the zone and reading
 * the difference back, which is the only zone database Node is
 * guaranteed to ship. ical.js has its own, but it is empty apart from
 * UTC unless VTIMEZONE definitions are registered, and a Google series
 * carries a zone name rather than a VTIMEZONE block.
 */
function zoneOffsetMinutes(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
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
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Turn a wall-clock reading into the instant it names in `zone`.
 *
 * The offset depends on the instant, and the instant is what we are
 * solving for, so this guesses with the offset at the naive reading and
 * then corrects once. One correction is enough: a second pass can only
 * differ inside a transition, where the wall-clock time is either
 * skipped or repeated and no exact answer exists. Both ambiguous cases
 * resolve forward, matching how calendar software presents them.
 */
function wallClockToInstant(wall: Date, zone: string | undefined): Date {
  if (!zone) return wall;
  const guess = new Date(
    wall.getTime() - zoneOffsetMinutes(wall, zone) * 60_000,
  );
  const corrected = new Date(
    wall.getTime() - zoneOffsetMinutes(guess, zone) * 60_000,
  );
  return corrected;
}

/** ICAL.Time carries the fields; read them as a naive (floating) Date. */
function icalTimeToWallClock(time: ICAL.Time): Date {
  return new Date(
    Date.UTC(
      time.year,
      time.month - 1,
      time.day,
      time.hour,
      time.minute,
      time.second,
    ),
  );
}

/**
 * Build the synthetic VEVENT the expander reads.
 *
 * The stored `recurrence` strings are already RFC 5545 property lines,
 * so reassembling a component from them is a faithful round trip rather
 * than a translation. DTSTART is written without a zone: expansion is
 * floating and the zone is applied to each result afterwards.
 */
function buildVevent(series: RecurrenceSeries): ICAL.Component {
  const dtstart = new Date(series.starts_at);
  if (Number.isNaN(dtstart.getTime())) {
    throw new RecurrenceExpansionError(
      `Series ${series.id} has an unreadable starts_at`,
    );
  }
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const floating = `${pad(dtstart.getUTCFullYear(), 4)}${pad(
    dtstart.getUTCMonth() + 1,
  )}${pad(dtstart.getUTCDate())}T${pad(dtstart.getUTCHours())}${pad(
    dtstart.getUTCMinutes(),
  )}${pad(dtstart.getUTCSeconds())}`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Marfa//occurrence expansion//EN",
    "BEGIN:VEVENT",
    "UID:marfa-expansion",
    `DTSTART:${floating}`,
    ...series.recurrence.map((line) => line.trim()).filter((line) => line),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  try {
    // ical.js types `parse` as `any`; the component constructor is the
    // only consumer and rejects anything that is not a parsed tree.
    const parsed = ICAL.parse(lines) as ConstructorParameters<
      typeof ICAL.Component
    >[0];
    const calendar = new ICAL.Component(parsed);
    const vevent = calendar.getFirstSubcomponent("vevent");
    if (!vevent) throw new Error("no vevent");
    return vevent;
  } catch (err) {
    throw new RecurrenceExpansionError(
      `Series ${series.id} has an unreadable recurrence rule: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Compute the occurrences of one series that start inside
 * `[windowStart, windowEnd)`.
 *
 * Exceptions are applied here rather than by the caller because
 * shadowing is part of what an occurrence *is*: the caller cannot tell a
 * computed occurrence that still stands from one that was replaced
 * without redoing the same matching.
 */
export function expandSeries(
  series: RecurrenceSeries,
  windowStart: Date,
  windowEnd: Date,
  exceptions: RecurrenceException[] = [],
): Occurrence[] {
  if (series.recurrence.length === 0) return [];

  const vevent = buildVevent(series);
  const dtstart = vevent.getFirstPropertyValue("dtstart") as ICAL.Time | null;
  if (!dtstart) {
    throw new RecurrenceExpansionError(
      `Series ${series.id} produced no start date`,
    );
  }

  const durationMs =
    series.ends_at !== undefined
      ? new Date(series.ends_at).getTime() -
        new Date(series.starts_at).getTime()
      : 0;

  // Keyed by the instant an exception replaces, so a shadowed occurrence
  // is recognized however the two were expressed.
  const shadowed = new Map<number, RecurrenceException>();
  for (const exception of exceptions) {
    const at = new Date(exception.original_starts_at).getTime();
    if (!Number.isNaN(at)) shadowed.set(at, exception);
  }

  const expansion = new ICAL.RecurExpansion({ component: vevent, dtstart });
  const occurrences: Occurrence[] = [];
  let next: ICAL.Time | null;
  let seen = 0;

  // ical.js types `next()` as always returning a Time, but it returns
  // null once the rule is exhausted — a COUNT or UNTIL series ends this
  // way, so the null is the normal termination, not an edge case.
  const nextOccurrence = (): ICAL.Time | null => expansion.next();

  while ((next = nextOccurrence())) {
    seen += 1;
    if (seen > MAX_OCCURRENCES_PER_SERIES) {
      throw new RecurrenceExpansionError(
        `Series ${series.id} yields more than ${String(MAX_OCCURRENCES_PER_SERIES)} occurrences in this window; narrow the window`,
      );
    }
    const startsAt = wallClockToInstant(
      icalTimeToWallClock(next),
      series.timezone,
    );
    if (startsAt >= windowEnd) break;
    if (startsAt < windowStart) continue;

    const exception = shadowed.get(startsAt.getTime());
    if (exception) {
      // The stored item carries its own times, so it is emitted by the
      // caller from the item itself; recording the shadow here is what
      // stops the computed occurrence being shown alongside it.
      occurrences.push({
        series_id: series.id,
        starts_at: startsAt.toISOString(),
        item_id: exception.id,
        replaces: startsAt.toISOString(),
      });
      continue;
    }

    occurrences.push({
      series_id: series.id,
      starts_at: startsAt.toISOString(),
      ...(durationMs > 0
        ? { ends_at: new Date(startsAt.getTime() + durationMs).toISOString() }
        : {}),
      item_id: series.id,
    });
  }

  return occurrences;
}
