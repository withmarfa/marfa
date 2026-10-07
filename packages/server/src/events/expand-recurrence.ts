/**
 * Read-time expansion of a recurring event series.
 *
 * A series is one item carrying its rule. Occurrences are computed over
 * the window a caller asks for and never materialize into storage, so a
 * rule that runs forever costs nothing until somebody asks about a
 * bounded stretch of time. The rule itself is unfolded by the shared
 * recurrence engine, which counts every candidate it considers; this file
 * adds what a series is beyond its rule.
 *
 * Exceptions. A moved or edited instance is stored as its own item
 * naming the occurrence it replaces. It shadows that occurrence: the
 * computed one disappears and the stored item takes its place, at the
 * stored item's own times.
 */
import {
  compileSchedule,
  occurrenceEndMs,
  occurrenceStarts,
  RecurrenceBoundError,
  RecurrenceCapError,
  RecurrenceMeter,
  RecurrenceRuleError,
  RECURRENCE_TIME_LIMIT_MS,
  RECURRENCE_WORK_LIMIT,
} from "@withmarfa/shared";
import type { CompiledSchedule } from "@withmarfa/shared";

export interface RecurrenceSeries {
  /** Item id of the series. */
  id: string;
  /** Start instant, ISO 8601, or a bare date for a whole-day series. */
  starts_at: string;
  /** End of the first occurrence. Absent means `duration`, or no length. */
  ends_at?: string;
  /** Length of each occurrence in seconds, read when there is no end. */
  duration?: number;
  /** Each occurrence occupies whole days in `timezone`. */
  all_day?: boolean;
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
  /** End instant, ISO 8601 UTC. Absent when the occurrence has no length. */
  ends_at?: string;
  /** The item to show: the series for a computed occurrence, the stored
   *  item for one an exception replaced. */
  item_id: string;
  /** Set when an exception shadows this occurrence. */
  replaces?: string;
}

/**
 * Ceiling on how many occurrences one series may contribute to a single
 * window. A daily rule over the maximum window is ~400, so anything past
 * this is a per-minute rule, and the caller is told rather than handed a
 * silently short list.
 */
export const MAX_OCCURRENCES_PER_SERIES = 2000;

/** Candidates one expansion may consider, pre-window ones included. */
export const MAX_EXPANSION_ITERATIONS = RECURRENCE_WORK_LIMIT;

export class RecurrenceExpansionError extends Error {}

/** An expansion stopped by one of its own bounds, the cost of its walk or
 *  the occurrences it may unfold in one window, so the series is missing
 *  occurrences rather than wrong. */
export class RecurrenceExpansionStopped extends RecurrenceExpansionError {}

/**
 * How much rule-walking one expansion did, for a caller that has to
 * budget in that unit. Accumulated whether the expansion returns or throws:
 * the refusal at the bound is the most expensive thing an expansion does.
 */
export interface ExpansionWork {
  /** Candidates considered, summed across every expansion that has been
   *  given this accumulator. */
  iterations: number;
}

/** Read a series, refusing it as its own failure rather than the read's. */
export function compileSeries(series: RecurrenceSeries): CompiledSchedule {
  try {
    return compileSchedule(series);
  } catch (err) {
    if (!(err instanceof RecurrenceRuleError)) throw err;
    throw new RecurrenceExpansionError(
      `Series ${series.id} has an unreadable recurrence rule: ${err.message}`,
    );
  }
}

/**
 * Compute the occurrences of one series that overlap
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
  work?: ExpansionWork,
  limits: { iterations?: number; timeMs?: number } = {},
): Occurrence[] {
  if (series.recurrence.length === 0) return [];
  const compiled = compileSeries(series);

  const shadowed = new Map<number, RecurrenceException>();
  for (const exception of exceptions) {
    const at = Date.parse(exception.original_starts_at);
    if (!Number.isNaN(at)) shadowed.set(at, exception);
  }

  const meter = new RecurrenceMeter(
    limits.iterations ?? MAX_EXPANSION_ITERATIONS,
    limits.timeMs ?? RECURRENCE_TIME_LIMIT_MS,
  );
  let starts: number[];
  try {
    starts = occurrenceStarts(
      compiled,
      windowStart.getTime(),
      windowEnd.getTime(),
      meter,
      MAX_OCCURRENCES_PER_SERIES,
    );
  } catch (err) {
    if (err instanceof RecurrenceCapError) {
      throw new RecurrenceExpansionStopped(
        `Series ${series.id} yields more than ${String(MAX_OCCURRENCES_PER_SERIES)} occurrences in this window; narrow the window`,
      );
    }
    if (err instanceof RecurrenceBoundError) {
      throw new RecurrenceExpansionStopped(
        `Series ${series.id} was stopped before it reaches the window's end: ${err.message}, so the rule is too costly to expand at read time`,
      );
    }
    throw err;
  } finally {
    if (work !== undefined) work.iterations += meter.spent;
  }

  return starts.map((ms) => {
    const startsAt = new Date(ms).toISOString();
    const exception = shadowed.get(ms);
    // The stored item carries its own times, so it is emitted by the
    // caller from the item itself; recording the shadow here is what
    // stops the computed occurrence being shown alongside it.
    if (exception) {
      return {
        series_id: series.id,
        starts_at: startsAt,
        item_id: exception.id,
        replaces: startsAt,
      };
    }
    const end = occurrenceEndMs(compiled, ms);
    return {
      series_id: series.id,
      starts_at: startsAt,
      ...(end > ms ? { ends_at: new Date(end).toISOString() } : {}),
      item_id: series.id,
    };
  });
}
