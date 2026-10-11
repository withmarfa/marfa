import { runForDuration } from "../../utils/pool.js";
import { computeMetrics, type LoadMetrics } from "./results.js";

/** Steady-state samples rotate the first level so cold/order effects are visible. */
export async function measureReaderRounds(
  read: () => Promise<unknown>,
  levels: readonly number[],
): Promise<{
  durations: number[];
  errors: number;
  throughput: number;
  breakdown: Record<string, LoadMetrics>;
}> {
  const breakdown: Record<string, LoadMetrics> = {};
  const durations: number[] = [];
  const perLevel = new Map<
    number,
    { durations: number[]; errors: number; elapsedMs: number }
  >();
  let errors = 0;
  for (let round = 0; round < 3; round++) {
    const order = [
      ...levels.slice(round % levels.length),
      ...levels.slice(0, round % levels.length),
    ];
    for (const level of order) {
      const warm = await runForDuration(read, 3_000, level);
      if (warm.errors.length)
        throw new Error(`Reader warm-up failed: ${warm.errors[0].message}`);
      const measured = await runForDuration(read, 5_000, level);
      const samples = measured.timings.map((timing) => timing.durationMs);
      const throughput = samples.length / (measured.totalDurationMs / 1000);
      const metrics = computeMetrics(
        samples,
        measured.errors.length,
        throughput,
      );
      breakdown[`readers=${level}/round=${round + 1}`] = metrics;
      console.log(
        `  readers=${level} round=${round + 1}: ${throughput.toFixed(1)} ops/s, p50=${metrics.p50.toFixed(1)}ms p95=${metrics.p95.toFixed(1)}ms p99=${metrics.p99.toFixed(1)}ms, ${samples.length} reads, ${measured.errors.length} errors`,
      );
      durations.push(...samples);
      errors += measured.errors.length;
      const aggregate = perLevel.get(level) ?? {
        durations: [],
        errors: 0,
        elapsedMs: 0,
      };
      aggregate.durations.push(...samples);
      aggregate.errors += measured.errors.length;
      aggregate.elapsedMs += measured.totalDurationMs;
      perLevel.set(level, aggregate);
    }
  }
  const rates: number[] = [];
  for (const [level, aggregate] of perLevel) {
    const throughput =
      aggregate.durations.length / (aggregate.elapsedMs / 1000);
    rates.push(throughput);
    breakdown[`readers=${level}`] = computeMetrics(
      aggregate.durations,
      aggregate.errors,
      throughput,
    );
  }
  return { durations, errors, throughput: Math.max(...rates), breakdown };
}
