/**
 * The write-path half of the normalized event instant columns.
 *
 * The `starts_at` and `ends_at` properties are stored exactly as their
 * upstream wrote them, which means an instant in whatever offset that
 * upstream happened to use. Two instants written `+02:00` and `Z` compare
 * as strings in the wrong order, so SQL cannot narrow a calendar window on
 * the property at all. The `items.starts_at` / `ends_at` columns carry the
 * same instants re-serialized in one shape, and this is what computes them.
 *
 * The shape is exactly what `Date.prototype.toISOString()` emits:
 * millisecond precision, `Z` suffix, fixed width. That fixed width is the
 * whole point — it is what makes lexical order and instant order the same
 * thing, so a `BETWEEN` on text answers a question about time.
 */

import {
  isEventDuration,
  isEventTimeZone,
  wholeDaySpan,
} from "@withmarfa/shared";

/** A whole day: no time, so no instant of its own. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A time with no zone named: no trailing `Z`, no `±HH:MM` offset. */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export interface InstantColumnValues {
  starts_at: string | null;
  ends_at: string | null;
}

function normalizeInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;

  let candidate = raw;
  if (BARE_DATE.test(raw)) {
    // The all-day model stores a bare date deliberately, because a whole
    // day has no instant. A timed event that carries one is read at UTC
    // midnight; a whole-day event is placed by `wholeDaySpan` instead.
    candidate = `${raw}T00:00:00.000Z`;
  } else if (NAIVE_DATETIME.test(raw)) {
    // A naive datetime is read as UTC, explicitly. Handing it to `new
    // Date()` unqualified would resolve it in whatever zone the server
    // happens to run in, so the same row would normalize differently on
    // two machines.
    candidate = `${raw.replace(" ", "T")}Z`;
  }

  const at = new Date(candidate);
  // Junk is a null column rather than a failed write. The field carries
  // no write-time format check, so unreadable values already exist and
  // the calendar read has always skipped them.
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString();
}

/**
 * The two column values for a row about to be written, derived from its
 * full property set.
 *
 * Keyed on field presence rather than on item type: any type declaring
 * the event shape gets the columns maintained, and nothing has to
 * enumerate which types those are.
 *
 * `ends_at` is when the row stops occupying time, which is what a window
 * asks: the stated end, else the start plus `duration` seconds. A row with
 * neither has no length, and the column is null. A whole-day row, single or
 * repeating, occupies whole days instead (`wholeDayColumnValues`).
 */
export function instantColumnValues(
  properties: Record<string, unknown>,
): InstantColumnValues {
  if (properties.all_day === true) return wholeDayColumnValues(properties);
  const startsAt = normalizeInstant(properties.starts_at);
  return {
    starts_at: startsAt,
    ends_at:
      normalizeInstant(properties.ends_at) ?? impliedEnd(startsAt, properties),
  };
}

function impliedEnd(
  startsAt: string | null,
  properties: Record<string, unknown>,
): string | null {
  if (startsAt === null) return null;
  const duration = properties.duration;
  if (typeof duration !== "number" || duration <= 0) return null;
  // Past the range a Date can hold there is no instant to store, so no end.
  const at = new Date(Date.parse(startsAt) + duration * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** A value read as the day or instant it names, ready for `wholeDaySpan`. */
function wholeDayValue(value: unknown): string | undefined {
  const normalized = normalizeInstant(value);
  if (normalized === null) return undefined;
  const raw = (value as string).trim();
  return BARE_DATE.test(raw) ? normalized.slice(0, 10) : normalized;
}

/**
 * The columns of a whole-day row: local midnight of its first day to local
 * midnight of the day it ends on, in its `timezone` or in UTC when it names
 * none. It is the rule a repeating whole-day series places each occurrence
 * by, so the same day falls in the same windows whether or not it repeats.
 */
function wholeDayColumnValues(
  properties: Record<string, unknown>,
): InstantColumnValues {
  const startsAt = wholeDayValue(properties.starts_at);
  if (startsAt === undefined) return { starts_at: null, ends_at: null };
  const { ends_at, duration, timezone } = properties;
  const endsAt = wholeDayValue(ends_at);
  try {
    const span = wholeDaySpan({
      starts_at: startsAt,
      ...(endsAt !== undefined ? { ends_at: endsAt } : {}),
      ...(typeof duration === "number" && isEventDuration(duration)
        ? { duration }
        : {}),
      ...(typeof timezone === "string" && isEventTimeZone(timezone)
        ? { timezone }
        : {}),
    });
    return {
      starts_at: new Date(span.startMs).toISOString(),
      ends_at: new Date(span.endMs).toISOString(),
    };
  } catch (err) {
    // A day past the range a Date holds has no span rather than a failed write.
    if (err instanceof RangeError) {
      return { starts_at: null, ends_at: null };
    }
    throw err;
  }
}
