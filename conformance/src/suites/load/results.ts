/**
 * Load test result types and persistence utilities.
 * Each scenario writes structured JSON to reports/load/ for aggregation.
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { percentile } from "../../utils/timing.js";

export interface LoadMetrics {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  runs: number;
  errors: number;
  throughput?: number; // ops/sec or items/sec
}

export interface LoadThreshold {
  target: string; // e.g. "p95 < 100ms"
  passed: boolean;
}

export interface LoadResult {
  scenario: string;
  profile: string;
  itemCount: number;
  timestamp: string;
  metrics: LoadMetrics;
  threshold?: LoadThreshold;
  breakdown?: Record<string, LoadMetrics>;
}

export function computeMetrics(
  durations: number[],
  errors = 0,
  throughput?: number,
): LoadMetrics {
  if (durations.length === 0) {
    return {
      p50: 0,
      p95: 0,
      p99: 0,
      mean: 0,
      min: 0,
      max: 0,
      runs: 0,
      errors,
      throughput,
    };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: sorted.reduce((sum, d) => sum + d, 0) / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    runs: sorted.length,
    errors,
    throughput,
  };
}

const REPORTS_DIR = "reports/load";

export async function saveLoadResult(result: LoadResult): Promise<string> {
  if (!existsSync(REPORTS_DIR)) {
    await mkdir(REPORTS_DIR, { recursive: true });
  }

  const filename = `${result.scenario.toLowerCase().replace(/\./g, "-")}-${result.profile}.json`;
  const filepath = `${REPORTS_DIR}/${filename}`;
  await writeFile(filepath, JSON.stringify(result, null, 2));
  return filepath;
}

export function logResult(result: LoadResult): void {
  const m = result.metrics;
  const status = result.threshold
    ? result.threshold.passed
      ? "PASS"
      : "FAIL"
    : "----";
  const throughputStr = m.throughput
    ? ` | ${m.throughput.toFixed(1)} ops/s`
    : "";
  console.log(
    `  [${status}] ${result.scenario} (${result.profile}, ${result.itemCount.toLocaleString()} items) ` +
      `p50=${m.p50.toFixed(1)}ms p95=${m.p95.toFixed(1)}ms p99=${m.p99.toFixed(1)}ms` +
      `${throughputStr} | ${m.runs} runs, ${m.errors} errors`,
  );
}
