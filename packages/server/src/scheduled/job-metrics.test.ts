/**
 * Real-pg-boss tests for the scheduled-job survey, in the shape of
 * `pg-boss-schedules.test.ts`: a genuine PgBoss against a throwaway
 * database clone, because everything under test is a reading of
 * `pgboss.job` and `pgboss.queue` — the shape of those rows, and the
 * clamp against the retention they carry, are pg-boss's, not this
 * module's.
 *
 * PG-only: skipped on the SQLite matrix. `scripts/test-pg.sh` provides
 * the container + DB_DIALECT=pg.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { cloneTemplate } from "../storage/pg/test-template.js";
import { createConnection } from "../storage/pg/connection.js";
import {
  queueNameFor,
  startPgBossSchedules,
  type ScheduledJobSpec,
} from "./pg-boss-schedules.js";
import { surveyScheduledJobs, type ScheduledJobTicks } from "./job-metrics.js";

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
 *  test budget; production derives both from each job's own interval. */
const FAST = { pollingIntervalSeconds: 0.5, seedDelaySeconds: 1 };

/** Named lookup, so a test asserting on one job fails loudly if the survey
 *  dropped it rather than passing on an absent key. */
function jobNamed(jobs: ScheduledJobTicks[], name: string): ScheduledJobTicks {
  const found = jobs.find((job) => job.name === name);
  if (!found) {
    throw new Error(
      `survey returned no entry for ${name} (got: ${jobs.map((job) => job.name).join(", ") || "nothing"})`,
    );
  }
  return found;
}

/** Run one job on a queue through to `completed`, returning its id. */
async function completeOne(
  boss: Awaited<ReturnType<typeof makeBoss>>,
  queue: string,
): Promise<string> {
  const id = await boss.send(queue, {});
  if (id === null) throw new Error(`${queue} refused the seeded job`);
  const [fetched] = await boss.fetch(queue);
  if (!fetched) throw new Error(`nothing was fetchable from ${queue}`);
  await boss.complete(queue, fetched.id);
  return fetched.id;
}

/**
 * Poll the survey until the named job reports at least `ticks` of them.
 *
 * Waits on the recorded rows rather than on a counter the handler bumps,
 * so a pass cannot come from a chain that ran without leaving one. Absence
 * is tolerated here and asserted afterwards: a job the survey has dropped
 * should fail the assertion that names it, not time out in the wait.
 */
async function waitForTicks(
  db: Awaited<ReturnType<typeof createConnection>>["db"],
  jobNames: string[],
  name: string,
  ticks: number,
  budgetMs: number,
): Promise<Awaited<ReturnType<typeof surveyScheduledJobs>>> {
  const deadline = Date.now() + budgetMs;
  let report = await surveyScheduledJobs(db, jobNames);
  const reached = (r: typeof report): boolean =>
    (r.jobs.find((job) => job.name === name)?.ticks ?? 0) >= ticks;
  while (!reached(report) && Date.now() < deadline) {
    await sleep(250);
    report = await surveyScheduledJobs(db, jobNames);
  }
  return report;
}

/** One clone, one boss, one connection, torn down in reverse. */
async function withPg(
  body: (ctx: {
    boss: Awaited<ReturnType<typeof makeBoss>>;
    db: Awaited<ReturnType<typeof createConnection>>["db"];
  }) => Promise<void>,
): Promise<void> {
  const clone = await cloneTemplate();
  try {
    const boss = await makeBoss(clone.url);
    const conn = await createConnection(clone.url, {
      maxPoolSize: 2,
      skipBootstrap: true,
    });
    try {
      await body({ boss, db: conn.db });
    } finally {
      await conn.close();
      await boss.stop({ graceful: false, timeout: 5_000 });
    }
  } finally {
    await clone.drop();
  }
}

describe.skipIf(!isPg)("scheduled-job survey", () => {
  it("separates a job that has ticked from one that never has", async () => {
    await withPg(async ({ boss, db }) => {
      const job: ScheduledJobSpec = {
        name: "survey-ticker",
        logName: "Survey ticker",
        intervalMs: 1000,
        runOnce: () => Promise.resolve(),
      };
      await startPgBossSchedules(boss, [job], FAST);

      const report = await waitForTicks(
        db,
        ["survey-ticker", "survey-silent"],
        "survey-ticker",
        1,
        20_000,
      );
      const ran = jobNamed(report.jobs, "survey-ticker");
      // `survey-silent` is registered here and never registered with the
      // boss, so it owns no queue and no rows — the "has not run since
      // boot" case, which a survey driven off `pgboss.job` could not name
      // at all.
      const silent = jobNamed(report.jobs, "survey-silent");

      expect(ran.ticks).toBeGreaterThanOrEqual(1);
      expect(ran.last_completed_at).not.toBeNull();
      expect(new Date(ran.last_completed_at ?? "").getTime()).not.toBeNaN();

      expect(silent.ticks).toBe(0);
      expect(silent.last_completed_at).toBeNull();
      expect(silent.last_failed_at).toBeNull();
      expect(silent.slowest_tick_ms).toBeNull();
    });
  }, 40_000);

  it("reports the slowest tick in the window, not the last one", async () => {
    await withPg(async ({ boss, db }) => {
      let tick = 0;
      const job: ScheduledJobSpec = {
        name: "survey-slow",
        logName: "Survey slow",
        intervalMs: 1000,
        runOnce: async () => {
          tick += 1;
          // Slow first, quick afterwards, so a survey reporting the most
          // recent duration instead of the maximum reads near zero.
          if (tick === 1) await sleep(900);
        },
      };
      await startPgBossSchedules(boss, [job], FAST);

      const survey = jobNamed(
        (await waitForTicks(db, ["survey-slow"], "survey-slow", 2, 30_000))
          .jobs,
        "survey-slow",
      );

      expect(survey.ticks).toBeGreaterThanOrEqual(2);
      expect(survey.slowest_tick_ms).not.toBeNull();
      expect(survey.slowest_tick_ms).toBeGreaterThanOrEqual(800);
      // A duration, not the string `bigint` reaches the driver as.
      expect(typeof survey.slowest_tick_ms).toBe("number");
    });
  }, 45_000);

  it("reports a queue-level failure without calling it a completion", async () => {
    await withPg(async ({ boss, db }) => {
      const queue = queueNameFor("survey-failing");
      await boss.createQueue(queue, { policy: "stately" });
      const id = await boss.send(queue, {}, { retryLimit: 0 });
      expect(id, "the seeded job was not accepted by the queue").not.toBeNull();
      const [fetched] = await boss.fetch(queue);
      if (!fetched) throw new Error("nothing was fetchable from the queue");
      await boss.fail(queue, fetched.id, new Error("tick abandoned"));

      const survey = jobNamed(
        (await surveyScheduledJobs(db, ["survey-failing"])).jobs,
        "survey-failing",
      );
      expect(survey.last_failed_at).not.toBeNull();
      // The two are read from different states, so a failure must not
      // also register as the last success.
      expect(survey.last_completed_at).toBeNull();
      expect(survey.ticks).toBe(1);
    });
  }, 30_000);

  it("counts only the ticks inside the window, not everything retained", async () => {
    await withPg(async ({ boss, db }) => {
      // pg-boss keeps a completed row for seven days by default, so the
      // window and the retention are different horizons. A count that
      // reported everything still on the table would answer a question
      // nobody asked and call it a day's worth.
      const queue = queueNameFor("survey-aged");
      await boss.createQueue(queue, { policy: "stately" });
      const aged = await completeOne(boss, queue);
      await db.execute(
        sql`UPDATE pgboss.job
            SET completed_on = now() - interval '3 days'
            WHERE id = ${aged}::uuid`,
      );
      const recent = await completeOne(boss, queue);
      expect(recent).not.toBe(aged);

      const survey = jobNamed(
        (await surveyScheduledJobs(db, ["survey-aged"])).jobs,
        "survey-aged",
      );
      expect(survey.ticks).toBe(1);
      // The older tick is still on record — it is out of the count, not
      // out of the answer — so the last completion must not have moved
      // backwards with it.
      expect(survey.last_completed_at).not.toBeNull();
      expect(
        Date.now() - new Date(survey.last_completed_at ?? "").getTime(),
      ).toBeLessThan(60_000);
    });
  }, 30_000);

  it("clamps the window to the queue's own retention", async () => {
    await withPg(async ({ boss, db }) => {
      // pg-boss deletes a completed row `deleteAfterSeconds` after it
      // finished. Asking for 24 hours of ticks from a queue that keeps one
      // would report a single hour's worth as a day's.
      await boss.createQueue(queueNameFor("survey-shortlived"), {
        policy: "stately",
        deleteAfterSeconds: 3600,
      });

      const clamped = await surveyScheduledJobs(db, ["survey-shortlived"], 24);
      expect(clamped.window_hours).toBe(1);

      // And the clamp is a ceiling, not a rewrite: a window already inside
      // retention is left where the caller put it.
      const inside = await surveyScheduledJobs(db, ["survey-shortlived"], 0.25);
      expect(inside.window_hours).toBe(0.25);
    });
  }, 30_000);

  it("does not let a never-delete queue collapse the window to zero", async () => {
    await withPg(async ({ boss, db }) => {
      // pg-boss spells "keep completed jobs forever" as `deleteAfterSeconds:
      // 0`, which is the loosest retention there is. Read as a bound it is
      // the tightest, and every count would come back zero.
      const queue = queueNameFor("survey-forever");
      await boss.createQueue(queue, {
        policy: "stately",
        deleteAfterSeconds: 0,
      });
      await completeOne(boss, queue);

      const report = await surveyScheduledJobs(db, ["survey-forever"]);
      expect(report.window_hours).toBe(24);
      // The count is what a collapsed window would silently empty, so
      // assert on it rather than on the window alone.
      expect(jobNamed(report.jobs, "survey-forever").ticks).toBe(1);
    });
  }, 30_000);

  it("keeps the default window when no scheduled queue exists yet", async () => {
    await withPg(async ({ db }) => {
      // A web-role process reads this before the worker has created any
      // queue. No queue row means no retention to clamp against, and the
      // absent row must not collapse the window to zero.
      const report = await surveyScheduledJobs(db, ["survey-unqueued"]);
      expect(report.window_hours).toBe(24);
      expect(jobNamed(report.jobs, "survey-unqueued").ticks).toBe(0);
    });
  }, 30_000);
});
