import type { PerfResult } from "../client/types.js";

export async function measure<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

export async function benchmark(
  name: string,
  fn: () => Promise<void>,
  options: { warmup?: number; runs?: number } = {},
): Promise<PerfResult> {
  const { warmup = 3, runs = 10 } = options;

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const durations: number[] = [];
  for (let i = 0; i < runs; i++) {
    const { durationMs } = await measure(fn);
    durations.push(durationMs);
  }

  durations.sort((a, b) => a - b);

  return {
    name,
    runs,
    min: durations[0],
    max: durations[durations.length - 1],
    mean: durations.reduce((sum, d) => sum + d, 0) / durations.length,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}
