/**
 * The one event a scheduled night sends to PostHog, so a drift in the figures
 * shows in an insight and not only in a run's summary.
 */
import type { Unit } from "./figures.js";
import { failedCount, verdictOf, type FiguresFile } from "./report.js";

export const EVENT_NAME = "marfa nightly benchmark";

const SUFFIX: Record<Unit, string> = {
  ms: "ms",
  s: "s",
  MB: "mb",
  ratio: "ratio",
  per_s: "per_s",
  count: "count",
  cpu_s_per_min: "cpu_s_per_min",
};

/** `get_item_p95_ms` for a distribution's p95, `rss_at_rest_mb` for a scalar. */
export function propertyName(
  name: string,
  unit: Unit,
  stat: "p50" | "p95" | "value",
): string {
  return stat === "value"
    ? `${name}_${SUFFIX[unit]}`
    : `${name}_${stat}_${SUFFIX[unit]}`;
}

export interface BenchmarkEvent {
  api_key: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, number | string | boolean | null>;
}

export function benchmarkEvent(
  file: FiguresFile,
  sender: { token: string; distinctId: string },
): BenchmarkEvent {
  const properties: BenchmarkEvent["properties"] = {
    // One fixed id for every night would otherwise make one person.
    $process_person_profile: false,
    commit: file.commit,
    run_id: file.runId,
    profile: file.profile,
    items: file.items,
    passed: verdictOf(file).passed,
    failed_count: failedCount(file),
  };
  for (const figure of file.figures) {
    // A figure that took no measurement has no value to send: its zero would
    // read as the fastest night, and it is the verdict above that fails.
    if (figure.samples === 0 || !Number.isFinite(figure.value)) continue;
    if (figure.p95 !== null && figure.p50 !== null) {
      properties[propertyName(figure.name, figure.unit, "p50")] = figure.p50;
      properties[propertyName(figure.name, figure.unit, "p95")] = figure.p95;
    } else {
      properties[propertyName(figure.name, figure.unit, "value")] =
        figure.value;
    }
  }
  return {
    api_key: sender.token,
    event: EVENT_NAME,
    distinct_id: sender.distinctId,
    timestamp: file.date,
    properties,
  };
}

export function captureUrl(host: string): string {
  return `${host.replace(/\/+$/, "")}/i/v0/e/`;
}
