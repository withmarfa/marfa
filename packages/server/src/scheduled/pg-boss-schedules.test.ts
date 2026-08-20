/**
 * Real-pg-boss tests for the scheduled-job chains, in the shape of
 * `pgboss-integration.test.ts`: a genuine PgBoss against a throwaway
 * database clone, because the properties under test — chain continuation,
 * policy-refused duplicate seeds, persistence across a boss restart —
 * live in pg-boss's queue tables, not in this module's control flow.
 *
 * PG-only: skipped on the SQLite matrix. `scripts/test-pg.sh` provides
 * the container + DB_DIALECT=pg.
 */
import { describe, it, expect } from "vitest";
import { cloneTemplate } from "../storage/pg/test-template.js";
import {
  startPgBossSchedules,
  repairSchedules,
  queueNameFor,
  type ScheduledJobSpec,
} from "./pg-boss-schedules.js";

const isPg = process.env.DB_DIALECT === "pg";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function makeBoss(url: string) {
  const { PgBoss } = await import("pg-boss");
  const boss = new PgBoss({ connectionString: url, max: 2 });
  boss.on("error", () => {
    // Maintenance errors surface on 'error'; swallowed so an emit after
    // the test's own teardown can't crash the runner.
  });
  await boss.start();
  return boss;
}

/** Fast polling so a 1s-interval chain ticks within a test budget; the
 *  production instance keeps pg-boss's default. */
const FAST_POLL = { pollingIntervalSeconds: 0.5 };

describe.skipIf(!isPg)("pg-boss scheduled-job chains", () => {
  it("ticks repeatedly through the self-requeueing chain", async () => {
    const clone = await cloneTemplate();
    const boss = await makeBoss(clone.url);
    try {
      let ticks = 0;
      const job: ScheduledJobSpec = {
        name: "test-chain-ticks",
        intervalMs: 1000,
        runOnce: () => {
          ticks += 1;
          return Promise.resolve();
        },
      };
      await startPgBossSchedules(boss, [job], FAST_POLL);
      const deadline = Date.now() + 20_000;
      while (ticks < 2 && Date.now() < deadline) {
        await sleep(250);
      }
      // Two ticks proves the chain: the first came from the seed, the
      // second only exists because the first tick's handler re-sent.
      expect(ticks).toBeGreaterThanOrEqual(2);
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
      await clone.drop();
    }
  }, 30_000);

  it("continues the chain after a tick that throws, and logs rather than retries", async () => {
    const clone = await cloneTemplate();
    const boss = await makeBoss(clone.url);
    try {
      let ticks = 0;
      const job: ScheduledJobSpec = {
        name: "test-chain-throws",
        intervalMs: 1000,
        runOnce: () => {
          ticks += 1;
          if (ticks === 1) {
            return Promise.reject(new Error("first tick fails"));
          }
          return Promise.resolve();
        },
      };
      await startPgBossSchedules(boss, [job], FAST_POLL);
      const deadline = Date.now() + 20_000;
      while (ticks < 2 && Date.now() < deadline) {
        await sleep(250);
      }
      // The second tick only happens if the throwing first tick still
      // re-sent its successor — the chain survives failures.
      expect(ticks).toBeGreaterThanOrEqual(2);
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
      await clone.drop();
    }
  }, 30_000);

  it("refuses duplicate seeds while a chain is alive", async () => {
    const clone = await cloneTemplate();
    const boss = await makeBoss(clone.url);
    try {
      const job: ScheduledJobSpec = {
        name: "test-chain-dedupe",
        // Long interval: the seeded tick stays queued for the whole test,
        // so every repair below hits an alive chain.
        intervalMs: 3_600_000,
        runOnce: () => Promise.resolve(),
      };
      await startPgBossSchedules(boss, [job], FAST_POLL);
      await repairSchedules(boss, [job]);
      await repairSchedules(boss, [job]);
      await repairSchedules(boss, [job]);
      const stats = await boss.getQueueStats(queueNameFor(job.name));
      // One queued successor no matter how many times the chain is
      // re-seeded: the stately policy is the dedupe, not caller
      // discipline.
      expect(stats.totalCount).toBe(1);
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
      await clone.drop();
    }
  }, 30_000);
});
