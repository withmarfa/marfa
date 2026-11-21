/**
 * Seconds each file ran in CI, for splitting a project over its shards
 * (`shard-sequencer.ts`). Only files that run for 20 seconds or more are
 * named. A file not named is weighed at `UNKNOWN_SECONDS`, so a new file is
 * still run, by exactly one shard, and a stale number costs balance and never
 * a file.
 *
 * Each number is the mean of one file's time over six green full runs, read
 * off the per-file lines of the shard logs and rounded to 5 seconds.
 * The `Compare each file's time with its weight` step of `ci.yml` compares
 * them with every shard's own times and writes the table to the job summary,
 * so a number that has drifted shows there.
 */
export const SHARD_SECONDS: Readonly<Record<string, number>> = {
  "src/suites/compliance/approval-screens.test.ts": 110,
  "src/suites/compliance/backup-faults.test.ts": 35,
  "src/suites/compliance/backup-folder.test.ts": 85,
  "src/suites/compliance/backup-thinning.test.ts": 30,
  "src/suites/compliance/backups.test.ts": 40,
  "src/suites/compliance/blob-cleanup-faults.test.ts": 65,
  "src/suites/compliance/blob-purge-faults.test.ts": 40,
  "src/suites/compliance/blob-rules.test.ts": 35,
  "src/suites/compliance/blob-store-jobs.test.ts": 55,
  "src/suites/compliance/blob-store-silent.test.ts": 85,
  "src/suites/compliance/bucket-sharing.test.ts": 35,
  "src/suites/compliance/bulk-job-holds.test.ts": 25,
  "src/suites/compliance/bulk-job-long.test.ts": 80,
  "src/suites/compliance/database-file.test.ts": 40,
  "src/suites/compliance/event-retention.test.ts": 55,
  "src/suites/compliance/export-credential.test.ts": 30,
  "src/suites/compliance/export-memory.test.ts": 55,
  "src/suites/compliance/health.test.ts": 135,
  "src/suites/compliance/housekeeping-feed-expiry.test.ts": 25,
  "src/suites/compliance/housekeeping-restart.test.ts": 30,
  "src/suites/compliance/housekeeping-retention.test.ts": 45,
  "src/suites/compliance/housekeeping-thinning.test.ts": 20,
  "src/suites/compliance/inbound-faults.test.ts": 25,
  "src/suites/compliance/inbound-retention.test.ts": 25,
  "src/suites/compliance/instance-lifecycle.test.ts": 30,
  "src/suites/compliance/item-write-live-key.test.ts": 45,
  "src/suites/compliance/job-chunk-faults.test.ts": 25,
  "src/suites/compliance/long-job-health.test.ts": 50,
  "src/suites/compliance/oauth-refusals.test.ts": 20,
  "src/suites/compliance/owner.test.ts": 305,
  "src/suites/compliance/restore-faults.test.ts": 30,
  "src/suites/compliance/restore-types-any-order.test.ts": 20,
  "src/suites/compliance/sign-in-limits.test.ts": 40,
  "src/suites/compliance/stream-credential.test.ts": 55,
  "src/suites/compliance/stream-stalled-reader.test.ts": 40,
  "src/suites/compliance/table-rows-lifecycle.test.ts": 35,
  "src/suites/compliance/table-rows-retention.test.ts": 95,
  "src/suites/compliance/upload-timing.test.ts": 75,
  "src/suites/compliance/web-page-register.test.ts": 20,
  "src/suites/compliance/webhook-delivery.test.ts": 40,
  "src/suites/compliance/webhook-lookup-slots.test.ts": 155,
  "src/suites/compliance/webhook-retries.test.ts": 40,
  "src/suites/device/body-edges-live.test.ts": 30,
  "src/suites/device/catch-up.test.ts": 135,
  "src/suites/device/classification.test.ts": 40,
  "src/suites/device/contract.test.ts": 35,
  "src/suites/device/folder-health.test.ts": 40,
  "src/suites/device/folder-patterns.test.ts": 65,
  "src/suites/device/folder-watch-record.test.ts": 115,
  "src/suites/device/folders-additions.test.ts": 20,
  "src/suites/device/folders-autostart.test.ts": 50,
  "src/suites/device/folders-contract-a.test.ts": 45,
  "src/suites/device/folders-contract-b.test.ts": 105,
  "src/suites/device/folders-copy-shrink.test.ts": 35,
  "src/suites/device/folders-frontmatter.test.ts": 190,
  "src/suites/device/folders-handover.test.ts": 125,
  "src/suites/device/folders-held-links.test.ts": 60,
  "src/suites/device/folders-identity.test.ts": 180,
  "src/suites/device/folders-one-mac.test.ts": 480,
  "src/suites/device/folders-placement.test.ts": 445,
  "src/suites/device/folders-refused-store-live.test.ts": 35,
  "src/suites/device/folders-retitled-links.test.ts": 25,
  "src/suites/device/folders-watch-every.test.ts": 80,
  "src/suites/device/folders.test.ts": 245,
  "src/suites/device/pages.test.ts": 55,
  "src/suites/device/queue.test.ts": 30,
  "src/suites/device/table-writes-live.test.ts": 75,
  "src/suites/device/tables-live.test.ts": 50,
  "src/suites/device/time-comparisons-live.test.ts": 25,
  "src/suites/device/upload-again-live.test.ts": 35,
  "src/suites/device/watch.test.ts": 30,
  "src/suites/device/working-copy.test.ts": 30,
};

/**
 * What a file not named above is weighed at: the median of every file of the
 * two split projects, named or not (4.9 seconds when it was measured). The
 * median of the named files alone is 45 seconds, which would weigh each of the
 * 340 small files that way and balance the shards by file count again.
 */
export const UNKNOWN_SECONDS = 5;

/**
 * Files no shard runs, because a job of its own does: `--shard` leaves them
 * out of every split, and a run without `--shard` still includes them. The
 * compliance fixture that runs the program a release ships needs the build
 * without test hooks, which the shards do not wait for.
 */
export const RUN_APART: readonly string[] = [
  "src/suites/compliance/hook-free-server.test.ts",
];
