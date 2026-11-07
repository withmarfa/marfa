/**
 * The figures the nightly scale benchmark records, and the ceilings that
 * decide whether a night passes.
 *
 * Every measuring step writes a fragment (a list of figures) and the last step
 * merges them (`report.ts`). A figure is written by one function here so that
 * its ceiling comes from `CEILINGS` alone: a step cannot record a number
 * against a bound of its own.
 */
import { percentile } from "../timing.js";

export type Unit =
  "ms" | "s" | "MB" | "ratio" | "per_s" | "count" | "cpu_s_per_min";

export interface Figure {
  /** Unit-free and stable across nights: the key a night is compared by. */
  name: string;
  unit: Unit;
  /** The figure the ceiling judges: the p95 of a distribution, else the value. */
  value: number;
  p50: number | null;
  p95: number | null;
  /** How many measurements a distribution holds. */
  samples: number | null;
  /** Requests that answered an error. Any makes the figure fail. */
  errors: number;
  ceiling: number | null;
  /** The issue whose acceptance criteria set the ceiling, where one did. */
  issue: number | null;
  passed: boolean;
  note: string | null;
}

export interface Fragment {
  step: string;
  figures: Figure[];
  /** The size of the instance, where the step counted it. */
  items: number | null;
}

interface CeilingEntry {
  /** An upper bound in the figure's unit; null where the figure is recorded only. */
  ceiling: number | null;
  issue: number | null;
  /**
   * The bound depends on another reading of the same night (resident memory
   * at rest plus a margin), so the step works it out and passes it in. The
   * margin is the table's: see `RSS_MARGIN_AFTER_BULK_MB`.
   */
  relative?: true;
}

/** How far above its resting reading memory may be, 10 s after a bulk page (#2609). */
export const RSS_MARGIN_AFTER_BULK_MB = 100;

const recorded: CeilingEntry = { ceiling: null, issue: null };

/**
 * Every figure the benchmark knows, with its ceiling and where the ceiling
 * comes from. The ceilings are the budgets the maintainer set after the scale
 * test on 2 November 2026.
 *
 * - The read budgets (an item, a list of 50, a common-word search) have no
 *   issue: they are what a person should not wait for on a large instance.
 * - #2606: reads during a bulk page, and the per-entry cost of a large page.
 *   The ratio's ceiling is 1.25, not 1: the issue asks for "no longer than",
 *   and a shared runner is noisy by more than the 25% the margin allows.
 * - #2609: resident memory at rest and a minute after a large bulk page.
 * - #2607: a `parent-of` write. The cycle check alone cannot be seen from
 *   outside, so the ceiling is on the whole request.
 * - #2612: the archive export of the whole instance.
 * - #2610: the scan of a first folder sync of 10,000 linked notes. The rest of
 *   the folder and device ceilings are the maintainer's budgets, with no issue:
 *   the whole first sync, a device copy of the instance and a server change
 *   reaching a following device. #2611 sets the edit-to-server time, and
 *   #2608 the quiet watch's CPU.
 */
export const CEILINGS: Record<string, CeilingEntry> = {
  // Reads at rest.
  get_item: { ceiling: 50, issue: null },
  list_50: { ceiling: 50, issue: null },
  search_common: { ceiling: 150, issue: null },
  search_rare: recorded,
  // No issue asks for a sorted task list yet, so it is recorded only.
  list_tasks_by_due: recorded,

  // Reads while a bulk page is written, one figure per reader.
  read_get_during_atomic_bulk: { ceiling: 100, issue: 2606 },
  read_health_during_atomic_bulk: { ceiling: 100, issue: 2606 },
  read_get_during_best_effort_bulk: { ceiling: 100, issue: 2606 },
  read_health_during_best_effort_bulk: { ceiling: 100, issue: 2606 },
  read_get_during_edge_bulk: { ceiling: 100, issue: 2606 },
  read_health_during_edge_bulk: { ceiling: 100, issue: 2606 },
  bulk_page_5000_per_entry: recorded,
  bulk_page_100_per_entry: recorded,
  bulk_page_ratio: { ceiling: 1.25, issue: 2606 },

  // Resident memory of the server process.
  rss_at_rest: { ceiling: 300, issue: 2609 },
  rss_after_bulk_1min: { ceiling: 300, issue: 2609 },
  // At rest plus RSS_MARGIN_AFTER_BULK_MB; the bulk step works the bound out.
  rss_after_bulk_10s: { ceiling: null, issue: 2609, relative: true },
  rss_growth_after_bulk: { ceiling: 100, issue: 2609 },
  rss_peak: recorded,

  parent_of_write: { ceiling: 50, issue: 2607 },

  archive_export: { ceiling: 300, issue: 2612 },
  archive_export_first_byte: recorded,

  // A first sync of 10,000 linked notes into the instance. The scan is
  // timed alone; the whole sync is the hydration, scan and push together.
  folder_scan: { ceiling: 60, issue: 2610 },
  folder_first_sync: { ceiling: 300, issue: null },
  folder_hydrate: recorded,
  folder_push: recorded,
  // The notes the server holds afterwards; a shortfall is an error.
  folder_notes_synced: recorded,

  // A watch on that folder: an edit reaching the server, and a quiet watch.
  folder_edit_to_server: { ceiling: 2000, issue: 2611 },
  folder_watch_cpu: { ceiling: 1, issue: 2608 },
  folder_watch_rss: recorded,

  // A device copying the instance, then following the event stream.
  device_hydrate: { ceiling: 60, issue: null },
  device_copy_size: recorded,
  device_follow_change: { ceiling: 1000, issue: null },

  server_restart: { ceiling: 2000, issue: null },
  server_restart_first: recorded,

  // Seeding. A server that answered an error leaves a smaller instance than
  // the figures claim, so any error fails the night.
  seed_rate: recorded,
  seed_errors: { ceiling: 0, issue: null },
  items_target: recorded,
  items_seeded: recorded,
  parent_of_edges: recorded,
  about_edges: recorded,

  // What the instance weighs, recorded so a drift shows.
  db_size: recorded,
  wal_size: recorded,
  rows_items: recorded,
};

/**
 * Figures known to be over their ceiling while the issue that fixes them is
 * open: figure name to issue number. Such a figure is recorded and shown with
 * its issue, but does not fail the night. Remove an entry when its issue
 * closes, and the figure fails the night from then on. A figure that answered
 * an error or took no measurement fails whether it is listed or not.
 */
export const KNOWN_OVER: Readonly<Record<string, number>> = {
  search_common: 2656,
  archive_export: 2657,
  bulk_page_ratio: 2658,
  device_hydrate: 2659,
};

/**
 * Items a second a whole seed reaches on a fast night. Hosted runners differ by
 * more than the ceilings allow, and a fixed CPU or disk loop does not show it:
 * nights that seeded at the same pace read 280 to 852 ms on one such loop.
 */
export const SEED_RATE_REFERENCE = 248;

/** A runner more than this many times slower than a fast night is slow. */
export const SLOW_RUNNER_FACTOR = 1.25;

/**
 * How far past its ceiling, beyond the runner's own slowness, a figure may be
 * and still be put down to the runner. A noisy host hits the tail hardest: an
 * edit's p95 reached 2.95 times its ceiling on a host 1.7 times slower.
 */
export const NOT_JUDGED_MARGIN = 2;

/**
 * How many times slower than a fast night tonight's seed ran; null when the
 * seed cannot say, since a partial seed's rate proves nothing.
 *
 * A regression in bulk writes lowers `seed_rate` too, so it can excuse the time
 * figures up to their bound. Those figures still show in the summary.
 */
export function runnerFactor(figures: readonly Figure[]): number | null {
  const reading = (name: string) => {
    const value = figures.find((figure) => figure.name === name)?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const rate = reading("seed_rate");
  const seeded = reading("items_seeded");
  const target = reading("items_target");
  const errors = reading("seed_errors");
  if (rate === null || seeded === null || target === null || errors === null) {
    return null;
  }
  if (rate <= 0 || seeded < target || errors > 0) return null;
  return SEED_RATE_REFERENCE / rate;
}

export function isSlowRunner(factor: number | null): factor is number {
  return factor !== null && factor > SLOW_RUNNER_FACTOR;
}

/** What a slower host costs more of: wall time, and the CPU time of the same work. */
const TIME_UNITS: readonly Unit[] = ["ms", "s", "cpu_s_per_min"];

/**
 * A slow runner explains a figure only when it measured what it should and came
 * in over a time ceiling. Errors, too few samples and no value are not slowness.
 */
export function overTimeCeilingAlone(figure: Figure): boolean {
  return (
    TIME_UNITS.includes(figure.unit) &&
    figure.ceiling !== null &&
    figure.errors === 0 &&
    Number.isFinite(figure.value) &&
    figure.value > figure.ceiling &&
    (figure.samples === null || figure.samples >= MIN_SAMPLES)
  );
}

/** Whether tonight's runner explains this figure's miss, up to the bound. */
export function explainedBySlowRunner(
  figure: Figure,
  figures: readonly Figure[],
): boolean {
  const factor = runnerFactor(figures);
  if (!isSlowRunner(factor) || !overTimeCeilingAlone(figure)) return false;
  return (
    figure.value <= (figure.ceiling as number) * factor * NOT_JUDGED_MARGIN
  );
}

function entryFor(name: string): CeilingEntry {
  const entry = CEILINGS[name];
  if (entry === undefined) {
    throw new Error(`no figure called "${name}" is in the ceilings table`);
  }
  return entry;
}

function judged(value: number, entry: CeilingEntry, errors: number): boolean {
  if (!Number.isFinite(value) || errors > 0) return false;
  return entry.ceiling === null || value <= entry.ceiling;
}

export interface FigureOptions {
  note?: string;
  errors?: number;
  /** Only for a figure whose entry is `relative`, and then required. */
  ceiling?: number;
}

function entryWith(name: string, options: FigureOptions): CeilingEntry {
  const entry = entryFor(name);
  if (entry.relative === true) {
    if (options.ceiling === undefined) {
      throw new Error(
        `the figure "${name}" needs the ceiling its step works out`,
      );
    }
    return { ...entry, ceiling: options.ceiling };
  }
  if (options.ceiling !== undefined) {
    throw new Error(
      `the figure "${name}" has a ceiling in the table; none may be passed`,
    );
  }
  return entry;
}

/** A figure that is one measurement. */
export function scalar(
  name: string,
  unit: Unit,
  value: number,
  options: FigureOptions = {},
): Figure {
  const entry = entryWith(name, options);
  const errors = options.errors ?? 0;
  return {
    name,
    unit,
    value,
    p50: null,
    p95: null,
    samples: null,
    errors,
    ceiling: entry.ceiling,
    issue: entry.issue,
    passed: judged(value, entry, errors),
    note: options.note ?? null,
  };
}

/**
 * The fewest samples a figure with a ceiling may rest on. A p95 of fewer is
 * close to the slowest request, so it neither shows a drift nor earns a pass.
 */
export const MIN_SAMPLES = 20;

/** A figure that is many measurements, headed by its p95. */
export function distribution(
  name: string,
  unit: Unit,
  samples: number[],
  options: FigureOptions = {},
): Figure {
  const entry = entryWith(name, options);
  const errors = options.errors ?? 0;
  if (samples.length === 0) {
    return {
      ...scalar(name, unit, Number.NaN, options),
      value: 0,
      samples: 0,
      passed: false,
      note: options.note ?? "no samples were measured",
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const tooFew = entry.ceiling !== null && sorted.length < MIN_SAMPLES;
  const note = [
    options.note,
    tooFew
      ? `${sorted.length} samples; a figure with a ceiling needs at least ${MIN_SAMPLES}`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
  return {
    name,
    unit,
    value: p95,
    p50: percentile(sorted, 50),
    p95,
    samples: sorted.length,
    errors,
    ceiling: entry.ceiling,
    issue: entry.issue,
    passed: !tooFew && judged(p95, entry, errors),
    note: note === "" ? null : note,
  };
}

export function fragmentOf(
  step: string,
  figures: Figure[],
  learned: { items?: number } = {},
): Fragment {
  return { step, figures, items: learned.items ?? null };
}
