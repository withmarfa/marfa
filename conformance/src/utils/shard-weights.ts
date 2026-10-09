/**
 * Seconds each file ran in CI, for splitting a project over its shards
 * (`shard-sequencer.ts`). Only files that run for 20 seconds or more are
 * named; a file not named is weighed at `UNKNOWN_SECONDS`, so a new file is
 * still run, by exactly one shard, and a stale number costs balance and never
 * a file.
 *
 * Read the times off the per-file lines of a CI shard's log and round them to
 * 5 seconds. The five `folders` files, which were one file, are scaled from
 * a run of each on one machine to the 1,381 seconds that file took in CI.
 */
export const SHARD_SECONDS: Readonly<Record<string, number>> = {
  "src/suites/compliance/archive-limits.test.ts": 100,
  "src/suites/compliance/audit-jobs.test.ts": 65,
  "src/suites/compliance/blob-store-bounds.test.ts": 25,
  "src/suites/compliance/blob-store-jobs.test.ts": 70,
  "src/suites/compliance/bulk-limits.test.ts": 175,
  "src/suites/compliance/fault-reports.test.ts": 40,
  "src/suites/compliance/health.test.ts": 110,
  "src/suites/compliance/inbound-retention.test.ts": 35,
  "src/suites/compliance/inbound-webhooks.test.ts": 25,
  "src/suites/compliance/instance-lifecycle.test.ts": 175,
  "src/suites/compliance/owner-client-auth.test.ts": 25,
  "src/suites/compliance/owner.test.ts": 310,
  "src/suites/compliance/restore-concurrent.test.ts": 45,
  "src/suites/compliance/search-depth.test.ts": 35,
  "src/suites/compliance/stream-credential.test.ts": 115,
  "src/suites/compliance/webhook-delivery.test.ts": 140,
  "src/suites/compliance/webhook-history.test.ts": 80,
  "src/suites/compliance/webhook-owner-standing.test.ts": 20,
  "src/suites/compliance/webhooks.test.ts": 65,
  "src/suites/device/catch-up.test.ts": 65,
  "src/suites/device/classification.test.ts": 40,
  "src/suites/device/contract.test.ts": 25,
  "src/suites/device/folder-patterns.test.ts": 60,
  "src/suites/device/folders-contract-a.test.ts": 65,
  "src/suites/device/folders-contract-b.test.ts": 65,
  "src/suites/device/folders-contract-extra-c.test.ts": 35,
  "src/suites/device/folders-frontmatter.test.ts": 110,
  "src/suites/device/folders-identity.test.ts": 220,
  "src/suites/device/folders-one-mac.test.ts": 420,
  "src/suites/device/folders-placement.test.ts": 325,
  "src/suites/device/folders.test.ts": 305,
  "src/suites/device/read-view-live.test.ts": 30,
  "src/suites/device/working-copy.test.ts": 25,
};

/** What a file not named above is weighed at: the mean of the files that are not. */
export const UNKNOWN_SECONDS = 5;
