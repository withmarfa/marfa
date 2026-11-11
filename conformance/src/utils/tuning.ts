/**
 * `MARFA_TEST_TUNING` shortens a timing or a batch the server fixes in code,
 * for a server booted with test hooks: comma-separated `name=value` pairs.
 * A name is `interval.<job>` or `interval.*` (every job a name does not give)
 * in milliseconds, one of the timings in milliseconds
 * (`housekeeping_poll_ms`, `write_wait_ms`, `upload_idle_ms`,
 * `blob_read_idle_ms`, `inbound_read_ms`, `connector_hold_ms`), or one of the
 * batch sizes (`enrichment_batch`, `blob_replicate_batch`,
 * `blob_replicate_batch_bytes`, `blob_integrity_batch`,
 * `blob_integrity_batch_bytes`).
 */
export const TUNING_SETTING = "MARFA_TEST_TUNING";

/** An interval no clock a fixture reaches gets past. */
export const NEVER_MS = "31536000000";

/** The longest the scheduler may go between looks for a job that is due. */
export const POLL_CEILING_MS = "3600000";

/** The settings that carry the given tuning pairs. */
export function tuning(...pairs: string[]): Record<string, string> {
  return { [TUNING_SETTING]: pairs.join(",") };
}

/** Keeps the scheduler from running jobs a fixture runs by hand. */
export const QUIET_TUNING: readonly string[] = [
  `housekeeping_poll_ms=${POLL_CEILING_MS}`,
  `interval.audit-cleanup=${NEVER_MS}`,
  `interval.trash-purge=${NEVER_MS}`,
  `interval.event-log-cleanup=${NEVER_MS}`,
  `interval.inbound-delivery-cleanup=${NEVER_MS}`,
  `interval.version-thinning=${NEVER_MS}`,
  `interval.feed-expiry=${NEVER_MS}`,
  `interval.credential-cleanup=${NEVER_MS}`,
  `interval.enrichment-sweep=${NEVER_MS}`,
];

/** Pairs in the order given; a name given twice takes its last value. */
export function mergedTuning(...texts: (string | undefined)[]): string {
  return texts.filter((text) => text).join(",");
}
