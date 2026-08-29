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
 * Instants in, wall clock in the middle, instants out. A stored start
 * is an instant: a point in time, carrying no zone of its own however
 * it happens to be written. But "weekly at 09:00" means 09:00 as the
 * calendar shows it in the series' own zone, on both sides of a
 * daylight-saving transition, which is a different number of elapsed
 * hours apart. So the stored instant is first rendered as the wall
 * clock it names in that zone, the rule is expanded in that floating
 * time, and each result is anchored back to an instant. A series with
 * no zone has no wall clock to keep, so its rule advances in UTC.
 *
 * Exceptions. A moved or edited instance is stored as its own item
 * naming the occurrence it replaces. It shadows that occurrence: the
 * computed one disappears and the stored item takes its place, at the
 * stored item's own times, which may fall outside the window the
 * computed occurrence sat in.
 */
import ICAL from "ical.js";
// The conversions between an instant and the reading a zone gives it are
// shared with the calendar mapping, which has to derive a whole day's date
// the same way this derives an occurrence's hour. Two copies of that would
// be two chances to disagree about a transition.
import {
  instantToWallClock,
  wallClockToInstant,
  zoneOffsetMinutes,
} from "@withmarfa/shared";

export interface RecurrenceSeries {
  /** Item id of the series. */
  id: string;
  /** Start instant, ISO 8601. */
  starts_at: string;
  /** End instant, ISO 8601. Optional; absent means a zero-length event. */
  ends_at?: string;
  /** IANA zone the series' schedule keeps its wall-clock hour in.
   *  Absent means the rule advances in UTC from the stored instant. */
  timezone?: string;
  /** RFC 5545 property lines: RRULE, RDATE, EXDATE. */
  recurrence: string[];
}

export interface RecurrenceException {
  /** Item id of the stored exception. */
  id: string;
  /** The start instant of the occurrence this replaces, ISO 8601. */
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
 * window. Counted against the window the caller asked for, never the
 * series' history: a daily rule over the maximum window is ~400, so
 * anything past this is a per-minute rule or a malformed one, and the
 * caller is told rather than handed a silently short list.
 */
export const MAX_OCCURRENCES_PER_SERIES = 2000;

/**
 * Ceiling on rule iterations for one expansion, pre-window skips
 * included. Expansion always walks from the series start, because the
 * rule's phase (INTERVAL, BYDAY defaults) is anchored there and cannot
 * be resumed mid-stream. A daily rule burns one iteration per day and
 * stays comfortably under this for centuries; a per-minute rule crosses
 * it in about ten weeks of history, which is the shape this exists to
 * stop from stalling a read.
 */
export const MAX_EXPANSION_ITERATIONS = 100_000;

export class RecurrenceExpansionError extends Error {}

/**
 * How much rule-walking one expansion did, for a caller that has to
 * budget in that unit.
 *
 * A series count says nothing about cost: one `COUNT=1` rule and one
 * per-minute rule created a year ago are the same number of series and
 * differ by five orders of magnitude in iterations. A caller pacing
 * itself against wall-clock work needs the second number, so the
 * expansion hands it back rather than leaving it to be guessed at.
 *
 * Accumulated on the way out, including when the expansion throws: the
 * refusal at `MAX_EXPANSION_ITERATIONS` is the single most expensive
 * thing this function does, and a budget that missed it would be blind
 * to exactly the shape it exists for.
 */
export interface ExpansionWork {
  /** Rule iterations performed, summed across every expansion that has
   *  been given this accumulator. */
  iterations: number;
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
 * than a translation. DTSTART is written without a zone: the stored
 * instant is rendered as its wall clock in the series zone, expansion
 * runs floating, and the zone is applied to each result afterwards.
 */
function buildVevent(series: RecurrenceSeries): ICAL.Component {
  const dtstart = new Date(series.starts_at);
  if (Number.isNaN(dtstart.getTime())) {
    throw new RecurrenceExpansionError(
      `Series ${series.id} has an unreadable starts_at`,
    );
  }

  // ical.js parses an EXRULE line and then never reads it, so letting
  // one through would silently produce the occurrences it was meant to
  // exclude. Refusing is the honest answer until something applies it.
  const exrule = series.recurrence.find((line) =>
    line.trim().toUpperCase().startsWith("EXRULE"),
  );
  if (exrule !== undefined) {
    throw new RecurrenceExpansionError(
      `Series ${series.id} carries an EXRULE, which is not applied; express exclusions as EXDATE lines`,
    );
  }

  // `timezone` is a plain string field on both event types, so any value
  // writes, and `Intl` raises a `RangeError` on one it cannot resolve.
  // That raise happens in the conversion below, outside every guard in
  // this file, so it reached the caller as a bug rather than as this
  // series' problem: one row carrying `Europe/Berlim` answered the whole
  // calendar with a 500, on every window, with the healthy meetings
  // beside it lost and no narrowing that recovered. Refusing the one
  // series is the rule the rest of this file already follows.
  //
  // Guarded on whether the zone resolves rather than through
  // `isValidTimeZone`, which is stricter than `Intl`: `Etc/GMT+5` fails
  // it and expands correctly here, so a read adopting it would take
  // working meetings off the calendar to fix rows that were never
  // broken.
  //
  // That helper is not a rule this field is held to. Its only caller is
  // the profile route; an event's `timezone` is declared a string and
  // checked to be one, and nothing checks that the string names a zone.
  // That is the premise of this guard rather than an aside, because it
  // is why a row like this exists to be read at all. Applying the
  // helper at the write is the fix worth having and belongs there;
  // until something does, the read has to survive whatever was stored.
  //
  // The probe warms the zone-formatter cache the conversions share, so
  // every later use of this zone in this expansion is a map hit and
  // cannot raise after it.
  //
  // Truthiness rather than `!== undefined`, because that is the test the
  // conversions themselves apply: an empty string is "no zone" to them
  // and expands in UTC, so probing it would refuse a series that works.
  if (series.timezone) {
    try {
      zoneOffsetMinutes(dtstart, series.timezone);
    } catch {
      throw new RecurrenceExpansionError(
        `Series ${series.id} carries a timezone that does not resolve: ${series.timezone}`,
      );
    }
  }

  const wall = instantToWallClock(dtstart, series.timezone);
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const floating = `${pad(wall.getUTCFullYear(), 4)}${pad(
    wall.getUTCMonth() + 1,
  )}${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}${pad(
    wall.getUTCMinutes(),
  )}${pad(wall.getUTCSeconds())}`;

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
 *
 * `work`, when given, is credited with the rule iterations this call
 * performed, whether it returns or throws. See `ExpansionWork`.
 */
export function expandSeries(
  series: RecurrenceSeries,
  windowStart: Date,
  windowEnd: Date,
  exceptions: RecurrenceException[] = [],
  work?: ExpansionWork,
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
  // is recognized however the two were expressed. Both sides of the
  // match are instants: the key here, and the re-anchored expansion
  // result below.
  const shadowed = new Map<number, RecurrenceException>();
  for (const exception of exceptions) {
    const at = new Date(exception.original_starts_at).getTime();
    if (!Number.isNaN(at)) shadowed.set(at, exception);
  }

  // ical.js raises plain errors out of the expansion machinery for
  // rules its parser accepted (a missing FREQ, an unreadable UNTIL), so
  // the constructor and the iterator are guarded the same way the parse
  // is: every malformed-rule shape surfaces as the expander's own error
  // type, which the route can attribute to the series.
  let expansion: ICAL.RecurExpansion;
  try {
    expansion = new ICAL.RecurExpansion({ component: vevent, dtstart });
  } catch (err) {
    throw new RecurrenceExpansionError(
      `Series ${series.id} has an unreadable recurrence rule: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const occurrences: Occurrence[] = [];
  let next: ICAL.Time | null;
  let iterations = 0;
  let emitted = 0;

  // ical.js types `next()` as always returning a Time, but it returns
  // null once the rule is exhausted — a COUNT or UNTIL series ends this
  // way, so the null is the normal termination, not an edge case.
  const nextOccurrence = (): ICAL.Time | null => {
    try {
      return expansion.next();
    } catch (err) {
      throw new RecurrenceExpansionError(
        `Series ${series.id} has an unreadable recurrence rule: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Pre-window history is skipped in floating time, before the exact
  // zone conversion: a wall-clock reading more than a day before the
  // window start cannot resolve to an instant inside it under any
  // offset on Earth, and the conversion is the expensive step when a
  // long-running series has years of history to walk past.
  const coarseCutoffMs =
    instantToWallClock(windowStart, series.timezone).getTime() - 86_400_000;

  try {
    while ((next = nextOccurrence())) {
      iterations += 1;
      if (iterations > MAX_EXPANSION_ITERATIONS) {
        throw new RecurrenceExpansionError(
          `Series ${series.id} iterates its rule more than ${String(MAX_EXPANSION_ITERATIONS)} times before it reaches the window; the rule is too frequent to expand at read time`,
        );
      }
      const wallClock = icalTimeToWallClock(next);
      if (wallClock.getTime() < coarseCutoffMs) continue;
      const startsAt = wallClockToInstant(wallClock, series.timezone);
      if (startsAt >= windowEnd) break;
      if (startsAt < windowStart) continue;

      emitted += 1;
      if (emitted > MAX_OCCURRENCES_PER_SERIES) {
        throw new RecurrenceExpansionError(
          `Series ${series.id} yields more than ${String(MAX_OCCURRENCES_PER_SERIES)} occurrences in this window; narrow the window`,
        );
      }

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
  } finally {
    // In a `finally` because the iteration ceiling above throws, and the
    // walk it abandons is the most expensive one this function performs.
    if (work !== undefined) work.iterations += iterations;
  }

  return occurrences;
}
