/**
 * The write-path half of the normalized event instant columns.
 *
 * `starts_at` and `ends_at` are stored exactly as their upstream wrote
 * them, which means an instant in whatever offset that upstream happened
 * to use. Two instants written `+02:00` and `Z` compare as strings in the
 * wrong order, so SQL cannot narrow a calendar window on the stored
 * value at all. `items.starts_at_utc` / `ends_at_utc` carry the same
 * instants re-serialized in one shape, and this is what computes them.
 *
 * The shape is exactly what `Date.prototype.toISOString()` emits:
 * millisecond precision, `Z` suffix, fixed width. That fixed width is the
 * whole point — it is what makes lexical order and instant order the same
 * thing, so a `BETWEEN` on text answers a question about time.
 */

/** A whole day: no time, so no instant of its own. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A time with no zone named: no trailing `Z`, no `±HH:MM` offset. */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export interface InstantColumnValues {
  starts_at_utc: string | null;
  ends_at_utc: string | null;
}

function normalizeInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;

  let candidate = raw;
  if (BARE_DATE.test(raw)) {
    // The all-day model stores a bare date deliberately, because a whole
    // day has no instant. UTC midnight is the projection the rest of the
    // calendar already gives it, so it is the one used here too.
    candidate = `${raw}T00:00:00.000Z`;
  } else if (NAIVE_DATETIME.test(raw)) {
    // A naive datetime is read as UTC, explicitly. Handing it to `new
    // Date()` unqualified would resolve it in whatever zone the server
    // happens to run in, so the same row would normalize differently on
    // two machines. The SQL backfills read naive values as UTC as well,
    // and the writers have to agree byte for byte or a backfilled row and
    // a rewritten one land on different instants.
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
 */
export function instantColumnValues(
  properties: Record<string, unknown>,
): InstantColumnValues {
  return {
    starts_at_utc: normalizeInstant(properties.starts_at),
    ends_at_utc: normalizeInstant(properties.ends_at),
  };
}
