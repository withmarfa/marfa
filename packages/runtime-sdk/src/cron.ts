/**
 * Cron-expression helper used by the per-Connection DO to compute the
 * next `alarm()` fire time from a manifest's schedule trigger.
 *
 * Wraps `cron-parser` v5 with a thin, UTC-only API. Manifests declare
 * cron in UTC; storage is millisecond timestamps; no local-time math
 * happens anywhere in the alarm path.
 */
import { CronExpressionParser } from "cron-parser";

/**
 * Compute the next time `cronExpr` is due strictly after `fromMs`.
 * Returns a millisecond timestamp suitable for `setAlarm`.
 *
 * Throws if `cronExpr` is not a valid 5-field cron expression.
 */
export function computeNextRunAt(cronExpr: string, fromMs: number): number {
  const iter = CronExpressionParser.parse(cronExpr, {
    currentDate: new Date(fromMs),
    tz: "UTC",
  });
  return iter.next().getTime();
}

/**
 * Validate a cron expression without throwing. Returns true iff the
 * input is a non-empty 5-field expression that `cron-parser` accepts.
 * Useful for manifest-time validation.
 */
export function isValidCron(cronExpr: string): boolean {
  const trimmed = cronExpr.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.split(/\s+/).length !== 5) return false;
  try {
    CronExpressionParser.parse(trimmed, { tz: "UTC" });
    return true;
  } catch {
    return false;
  }
}
