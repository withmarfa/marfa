/**
 * Shared measurement helpers for the `performance` suites. They keep the raw
 * durations beside the summary so an assertion can look at the distribution.
 */

import type { MarfaClient } from "../client/api.js";
import type {
  BulkItemInput,
  PerfResult,
  TestContext,
} from "../client/types.js";
import { trackItem } from "./setup.js";
import { measure, percentile } from "./timing.js";

/** Outcome of a measured series. */
export interface PerfSeries {
  summary: PerfResult;
  /** Sample durations, ascending. */
  samples: number[];
  /** Calls whose response was not a success status. */
  errors: number;
}

/**
 * Run `runs` measured iterations. `fn` reports whether the call succeeded so
 * a series that is fast only because the server is erroring can be caught by
 * the caller.
 */
export async function measureSeries(
  name: string,
  fn: () => Promise<boolean>,
  options: { runs: number },
): Promise<PerfSeries> {
  const samples: number[] = [];
  let errors = 0;

  for (let i = 0; i < options.runs; i++) {
    const { result, durationMs } = await measure(fn);
    if (!result) errors++;
    samples.push(durationMs);
  }

  samples.sort((a, b) => a - b);
  return { summary: summarize(name, samples), samples, errors };
}

/** Percentile summary over an already-collected set of durations. */
export function summarize(name: string, durations: number[]): PerfResult {
  const sorted = [...durations].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { name, runs: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }
  return {
    name,
    runs: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, d) => sum + d, 0) / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/**
 * Print one line per measured series. Percentile numbers are the point of
 * these suites, so they go to the console even on a passing run — a threshold
 * only says "not catastrophic", the printed distribution is what a human
 * compares against the last run.
 */
export function logPerf(series: PerfSeries, note?: string): void {
  const s = series.summary;
  const suffix = [
    series.errors > 0 ? `${String(series.errors)} errors` : "",
    note ?? "",
  ]
    .filter(Boolean)
    .join(" | ");
  console.log(
    `  ${s.name.padEnd(34)} n=${String(s.runs).padStart(3)} ` +
      `p50=${s.p50.toFixed(0).padStart(5)}ms p95=${s.p95.toFixed(0).padStart(5)}ms ` +
      `p99=${s.p99.toFixed(0).padStart(5)}ms max=${s.max.toFixed(0).padStart(5)}ms` +
      (suffix ? `  (${suffix})` : ""),
  );
}

/** Per-scale knobs for the performance suites. */
export interface PerfScaleConfig {
  /** Measured iterations for a cheap read benchmark. */
  runs: number;
  /** Items a suite seeds into its own source-scoped working set. */
  seedItems: number;
  /** Cumulative working-set sizes the volume suite steps through. */
  volumeSteps: number[];
  /** Measured iterations for blob transfers — larger payloads, fewer runs. */
  blobRuns: number;
}

/**
 * `small` is the default and must stay fast enough to run on every change; the
 * larger scales trade wall-clock for a tighter distribution and a bigger
 * working set. Every step is sized to fit one test body, since seeding an item
 * costs far more than the read being measured. Genuine high-volume behavior
 * belongs to the load suites, not here.
 */
export const PERF_SCALES: Record<
  "small" | "medium" | "large",
  PerfScaleConfig
> = {
  small: { runs: 12, seedItems: 30, volumeSteps: [40, 80, 120], blobRuns: 5 },
  medium: {
    runs: 20,
    seedItems: 80,
    volumeSteps: [100, 200, 300],
    blobRuns: 8,
  },
  large: {
    runs: 30,
    seedItems: 150,
    volumeSteps: [200, 400, 600],
    blobRuns: 12,
  },
};

/**
 * Seed a working set through `POST /items/bulk` and track every created id for
 * teardown.
 *
 * Seeding is not what these suites measure, but it dominates their wall clock,
 * so it goes through bulk rather than one create per item. Writes are stamped
 * with the credential's `source`, which is unique per test file, so the seeded
 * set stays addressable as `source=ctx.source`. `source_id` carries the run id
 * so a re-run seeds fresh rows instead of deduplicating onto the last run's.
 */
export async function seedWorkingSet(
  client: MarfaClient,
  ctx: TestContext,
  count: number,
  build: (index: number) => BulkItemInput,
  options: { batchSize?: number; label?: string } = {},
): Promise<string[]> {
  const { batchSize = 40, label = "seed" } = options;
  const ids: string[] = [];

  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset);
    const items = Array.from({ length: size }, (_, i) => {
      const index = offset + i;
      return {
        ...build(index),
        source_id: `${ctx.runId}-${label}-${String(index)}`,
      };
    });

    const res = await client.bulkItems({ items, mode: "create_only" });
    if (!res.ok) {
      throw new Error(
        `seedWorkingSet: bulk create failed with status ${String(res.status)}: ${JSON.stringify(res.error)}`,
      );
    }
    if (res.data.counts.errored > 0) {
      const first = res.data.results.find((r) => r.outcome === "errored");
      throw new Error(
        `seedWorkingSet: ${String(res.data.counts.errored)} of ${String(size)} items errored (first: ${JSON.stringify(first?.error)})`,
      );
    }
    for (const entry of res.data.results) {
      if (entry.id) {
        ids.push(entry.id);
        trackItem(ctx, entry.id);
      }
    }
  }

  return ids;
}
