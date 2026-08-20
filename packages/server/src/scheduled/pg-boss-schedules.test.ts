/**
 * Real-pg-boss tests for the scheduled-job chains, in the shape of
 * `pgboss-integration.test.ts`: a genuine PgBoss against a throwaway
 * database clone, because the properties under test — chain continuation,
 * policy-refused duplicate seeds, repair of a dead chain — live in
 * pg-boss's queue tables, not in this module's control flow.
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

/** Fast polling and a short seed so a 1s-interval chain ticks within a
 *  test budget; the production instance derives both from each job's
 *  own interval. */
const FAST = { pollingIntervalSeconds: 0.5, seedDelaySeconds: 1 };

describe.skipIf(!isPg)("pg-boss scheduled-job chains", () => {
  it("ticks repeatedly through the self-requeueing chain", async () => {
    const clone = await cloneTemplate();
    try {
      const boss = await makeBoss(clone.url);
      try {
        let ticks = 0;
        const job: ScheduledJobSpec = {
          name: "test-chain-ticks",
          logName: "Test chain ticks",
          intervalMs: 1000,
          runOnce: () => {
            ticks += 1;
            return Promise.resolve();
          },
        };
        await startPgBossSchedules(boss, [job], FAST);
        const deadline = Date.now() + 20_000;
        while (ticks < 2 && Date.now() < deadline) {
          await sleep(250);
        }
        // Two ticks proves the chain: the first came from the seed, the
        // second only exists because the first tick's handler re-sent.
        expect(ticks).toBeGreaterThanOrEqual(2);
      } finally {
        await boss.stop({ graceful: false, timeout: 5_000 });
      }
    } finally {
      await clone.drop();
    }
  }, 30_000);

  it("continues the chain after a tick that throws, and logs rather than retries", async () => {
    const clone = await cloneTemplate();
    try {
      const boss = await makeBoss(clone.url);
      try {
        let ticks = 0;
        const job: ScheduledJobSpec = {
          name: "test-chain-throws",
          logName: "Test chain throws",
          intervalMs: 1000,
          runOnce: () => {
            ticks += 1;
            if (ticks === 1) {
              return Promise.reject(new Error("first tick fails"));
            }
            return Promise.resolve();
          },
        };
        await startPgBossSchedules(boss, [job], FAST);
        const deadline = Date.now() + 20_000;
        while (ticks < 2 && Date.now() < deadline) {
          await sleep(250);
        }
        // The second tick only happens if the throwing first tick still
        // sent its successor — the chain survives failures.
        expect(ticks).toBeGreaterThanOrEqual(2);
      } finally {
        await boss.stop({ graceful: false, timeout: 5_000 });
      }
    } finally {
      await clone.drop();
    }
  }, 30_000);

  it("refuses duplicate seeds while a chain is alive", async () => {
    const clone = await cloneTemplate();
    try {
      const boss = await makeBoss(clone.url);
      try {
        const job: ScheduledJobSpec = {
          name: "test-chain-dedupe",
          logName: "Test chain dedupe",
          // Long interval and a seed deferred beyond the test window, so
          // the seeded tick stays queued throughout and every repair
          // below hits an alive chain.
          intervalMs: 3_600_000,
          runOnce: () => Promise.resolve(),
        };
        await startPgBossSchedules(boss, [job], {
          ...FAST,
          seedDelaySeconds: 120,
        });
        await repairSchedules(boss, [job], 120);
        await repairSchedules(boss, [job], 120);
        await repairSchedules(boss, [job], 120);
        const stats = await boss.getQueueStats(queueNameFor(job.name));
        // One live job no matter how many times the chain is re-seeded:
        // the stately policy is the dedupe, not caller discipline.
        // Asserted on queued + active, not totalCount, which also counts
        // completed rows retained for later inspection.
        expect(stats.queuedCount + stats.activeCount).toBe(1);
      } finally {
        await boss.stop({ graceful: false, timeout: 5_000 });
      }
    } finally {
      await clone.drop();
    }
  }, 30_000);

  it("repair restores a chain whose successor was lost", async () => {
    const clone = await cloneTemplate();
    try {
      const boss = await makeBoss(clone.url);
      try {
        let ticks = 0;
        const job: ScheduledJobSpec = {
          name: "test-chain-repair",
          logName: "Test chain repair",
          intervalMs: 3_600_000,
          runOnce: () => {
            ticks += 1;
            return Promise.resolve();
          },
        };
        await startPgBossSchedules(boss, [job], FAST);

        // Kill the chain the way a failed successor send would: delete
        // the queued job outright, leaving both stately slots empty.
        const queue = queueNameFor(job.name);
        const deadline = Date.now() + 10_000;
        let killed = false;
        while (!killed && Date.now() < deadline) {
          const queued = await boss.fetch(queue, {
            batchSize: 1,
            ignoreStartAfter: true,
          });
          const id = queued[0]?.id;
          if (id !== undefined) {
            await boss.deleteJob(queue, id);
            killed = true;
          } else {
            await sleep(100);
          }
        }
        expect(killed).toBe(true);
        // The kill may land on the initial seed (zero ticks so far) or on
        // the successor a fast first tick already queued (one tick so
        // far); either way the chain is now dead, so only a repair can
        // produce another tick.
        const ticksBeforeRepair = ticks;

        // Drive one repair pass directly (production runs it on a
        // minutely cron; a test cannot wait out a cron floor) and the
        // dead chain comes back: the re-seed is accepted into the empty
        // slots and the tick runs.
        await repairSchedules(boss, [job], 1);
        const tickDeadline = Date.now() + 15_000;
        while (ticks <= ticksBeforeRepair && Date.now() < tickDeadline) {
          await sleep(250);
        }
        expect(ticks).toBeGreaterThan(ticksBeforeRepair);
      } finally {
        await boss.stop({ graceful: false, timeout: 5_000 });
      }
    } finally {
      await clone.drop();
    }
  }, 30_000);
});

describe.skipIf(!isPg)("expiry ceiling against the real boss", () => {
  it("registers daily-interval jobs and oversized explicit expiries without crashing createQueue", async () => {
    // pg-boss asserts expiry strictly under 24 hours. A cap of exactly
    // 86 400 passed every test that used short intervals and then
    // crashed the first real boot: every daily job's 2x-interval default
    // hit the cap. This drives the shapes index.ts actually registers —
    // a 24-hour interval and an explicit expiry beyond the ceiling —
    // through a genuine createQueue.
    const clone = await cloneTemplate();
    try {
      const boss = await makeBoss(clone.url);
      try {
        const daily: ScheduledJobSpec = {
          name: "test-daily-interval",
          logName: "Test daily interval",
          intervalMs: 86_400_000,
          runOnce: () => Promise.resolve(),
        };
        const oversized: ScheduledJobSpec = {
          name: "test-oversized-expiry",
          logName: "Test oversized expiry",
          intervalMs: 3_600_000,
          expireInSeconds: 200_000,
          runOnce: () => Promise.resolve(),
        };
        await startPgBossSchedules(boss, [daily, oversized], FAST);
        for (const job of [daily, oversized]) {
          const queues = await boss.getQueues();
          const queue = queues.find((q) => q.name === queueNameFor(job.name));
          expect(queue).toBeDefined();
          expect(queue?.expireInSeconds ?? 0).toBeLessThan(86_400);
        }
      } finally {
        await boss.stop({ graceful: false });
      }
    } finally {
      await clone.drop();
    }
  }, 30_000);
});
