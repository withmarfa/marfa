import { secondsOf } from "./shard-sequencer.js";

/** A file whose time is below this, in both the weight and the measure, is noise. */
const SMALLEST_SECONDS = 20;

/** How far a measured time may be from its weight, as a share of the weight. */
const TOLERANCE = 0.5;

export interface Drift {
  path: string;
  weight: number;
  measured: number;
  /** Whether the time is further from the weight than the tolerance allows. */
  drifted: boolean;
}

/**
 * Every file's measured time against its weight. A file drifts when it is
 * more than half a weight away from it and either number is 20 seconds or
 * more: a small file moves by seconds from one run to the next, and only a
 * file that is slow, or weighed as though it were, changes how the shards
 * balance. Slowest first.
 */
export function compareTimes(
  measured: Readonly<Record<string, number>>,
  weigh: (path: string) => number = secondsOf,
): Drift[] {
  return Object.entries(measured)
    .map(([path, seconds]) => {
      const weight = weigh(path);
      return {
        path,
        weight,
        measured: seconds,
        drifted:
          Math.max(weight, seconds) >= SMALLEST_SECONDS &&
          Math.abs(seconds - weight) > TOLERANCE * weight,
      };
    })
    .sort((a, b) => b.measured - a.measured || (a.path < b.path ? -1 : 1));
}

/** The table for a job summary: the drifted files and every file of 10 seconds or more. */
export function summaryTable(rows: readonly Drift[]): string {
  const shown = rows.filter((row) => row.drifted || row.measured >= 10);
  const lines = [
    "| File | Weight (s) | Measured (s) | |",
    "| --- | ---: | ---: | --- |",
    ...shown.map(
      (row) =>
        `| \`${row.path}\` | ${String(row.weight)} | ${row.measured.toFixed(0)} | ${row.drifted ? "drifted" : ""} |`,
    ),
  ];
  return lines.join("\n");
}
