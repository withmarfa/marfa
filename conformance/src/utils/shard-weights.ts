/**
 * Seconds each file ran in CI, for splitting a project over its shards
 * (`shard-sequencer.ts`). Only files that run for 20 seconds or more are
 * named. A file not named is weighed at `UNKNOWN_SECONDS`, so a new file is
 * still run, by exactly one shard, and a stale number costs balance and never
 * a file.
 *
 * Each number is the mean of one file's time over three green runs on `main`,
 * read off the per-file lines of the shard logs and rounded to 5 seconds.
 * The `Check the shard weights` step of `ci.yml` compares them with every
 * shard's own times and writes the table to the job summary, so a number that
 * has drifted shows there.
 */
export const SHARD_SECONDS: Readonly<Record<string, number>> = {
  "src/suites/compliance/approval-screens.test.ts": 145,
  "src/suites/compliance/archive-limits.test.ts": 120,
  "src/suites/compliance/audit-jobs.test.ts": 55,
  "src/suites/compliance/blob-cleanup-faults.test.ts": 70,
  "src/suites/compliance/blob-purge-faults.test.ts": 40,
  "src/suites/compliance/blob-reach-app.test.ts": 20,
  "src/suites/compliance/blob-store-bounds.test.ts": 35,
  "src/suites/compliance/blob-store-folders.test.ts": 20,
  "src/suites/compliance/blob-store-jobs.test.ts": 45,
  "src/suites/compliance/blob-store-silent.test.ts": 85,
  "src/suites/compliance/bulk-job-holds.test.ts": 25,
  "src/suites/compliance/bulk-job-long.test.ts": 50,
  "src/suites/compliance/bulk-job-restart.test.ts": 30,
  "src/suites/compliance/bulk-limits.test.ts": 140,
  "src/suites/compliance/device-owner-limits.test.ts": 30,
  "src/suites/compliance/event-retention.test.ts": 55,
  "src/suites/compliance/export-credential.test.ts": 40,
  "src/suites/compliance/export-write-order.test.ts": 45,
  "src/suites/compliance/fault-reports.test.ts": 40,
  "src/suites/compliance/health.test.ts": 115,
  "src/suites/compliance/housekeeping-feed-expiry.test.ts": 30,
  "src/suites/compliance/housekeeping-restart.test.ts": 50,
  "src/suites/compliance/housekeeping-retention.test.ts": 80,
  "src/suites/compliance/housekeeping-thinning.test.ts": 30,
  "src/suites/compliance/inbound-faults.test.ts": 45,
  "src/suites/compliance/inbound-retention.test.ts": 50,
  "src/suites/compliance/inbound-source-continuity.test.ts": 25,
  "src/suites/compliance/inbound-webhooks.test.ts": 25,
  "src/suites/compliance/instance-lifecycle.test.ts": 240,
  "src/suites/compliance/item-write-live-key.test.ts": 35,
  "src/suites/compliance/oauth-refusals.test.ts": 30,
  "src/suites/compliance/owner-client-auth.test.ts": 35,
  "src/suites/compliance/owner-sign-ins.test.ts": 20,
  "src/suites/compliance/owner.test.ts": 330,
  "src/suites/compliance/restore-compatible-types.test.ts": 65,
  "src/suites/compliance/restore-concurrent.test.ts": 50,
  "src/suites/compliance/restore-edges-constraint-types.test.ts": 30,
  "src/suites/compliance/restore-rows-shape.test.ts": 25,
  "src/suites/compliance/search-depth.test.ts": 35,
  "src/suites/compliance/sign-in-limits.test.ts": 20,
  "src/suites/compliance/stop-webhook.test.ts": 25,
  "src/suites/compliance/stream-credential.test.ts": 115,
  "src/suites/compliance/stream-opening-faults.test.ts": 55,
  "src/suites/compliance/stream-prologue-holds.test.ts": 20,
  "src/suites/compliance/test-hooks.test.ts": 55,
  "src/suites/compliance/upload-timing.test.ts": 75,
  "src/suites/compliance/web-page-register.test.ts": 30,
  "src/suites/compliance/webhook-bulk-backlog.test.ts": 105,
  "src/suites/compliance/webhook-delivery.test.ts": 95,
  "src/suites/compliance/webhook-history.test.ts": 30,
  "src/suites/compliance/webhook-retries.test.ts": 35,
  "src/suites/compliance/webhook-schedule-gap.test.ts": 30,
  "src/suites/compliance/webhooks-owner.test.ts": 40,
  "src/suites/compliance/webhooks.test.ts": 65,
  "src/suites/device/body-edges-live.test.ts": 35,
  "src/suites/device/catch-up.test.ts": 125,
  "src/suites/device/classification.test.ts": 45,
  "src/suites/device/contract.test.ts": 35,
  "src/suites/device/folder-health.test.ts": 30,
  "src/suites/device/folder-patterns.test.ts": 75,
  "src/suites/device/folder-watch-record.test.ts": 130,
  "src/suites/device/folders-autostart.test.ts": 60,
  "src/suites/device/folders-contract-a.test.ts": 75,
  "src/suites/device/folders-contract-b.test.ts": 75,
  "src/suites/device/folders-contract-extra-c.test.ts": 30,
  "src/suites/device/folders-frontmatter.test.ts": 255,
  "src/suites/device/folders-handover.test.ts": 140,
  "src/suites/device/folders-identity.test.ts": 245,
  "src/suites/device/folders-one-mac.test.ts": 640,
  "src/suites/device/folders-placement.test.ts": 535,
  "src/suites/device/folders-refused-store-live.test.ts": 50,
  "src/suites/device/folders-unmatched.test.ts": 25,
  "src/suites/device/folders-watch-every.test.ts": 110,
  "src/suites/device/folders.test.ts": 385,
  "src/suites/device/pages.test.ts": 50,
  "src/suites/device/queue.test.ts": 40,
  "src/suites/device/reach-live.test.ts": 35,
  "src/suites/device/stuck-write.test.ts": 20,
  "src/suites/device/time-comparisons-live.test.ts": 25,
  "src/suites/device/watch.test.ts": 30,
  "src/suites/device/working-copy.test.ts": 35,
};

/**
 * What a file not named above is weighed at: the median of every file of the
 * two split projects, named or not (4.9 seconds when it was measured). The
 * median of the named files alone is 45 seconds, which would weigh each of the
 * 340 small files that way and balance the shards by file count again.
 */
export const UNKNOWN_SECONDS = 5;
