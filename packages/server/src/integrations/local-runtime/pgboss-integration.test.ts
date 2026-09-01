/**
 * Real pg-boss integration smoke test for the local runtime.
 *
 * The supervisor's other tests drive dispatches through the `directDispatch`
 * test seam and pass `boss: null`, so they never construct a real PgBoss. Two
 * boot-time regressions shipped unnoticed because of that gap: pg-boss 12 moved
 * the class to a named export (the constructor was read off `.default`), and it
 * validates queue/schedule names against `[A-Za-z0-9_.\-/]` (the schedule
 * prefix carried a `:`). This test boots a real PgBoss against a throwaway
 * Postgres database to exercise the actual constructor + queue API the runtime
 * depends on, so the class of bug can't silently return.
 *
 * PG-only: skipped on the SQLite matrix (the local substrate requires
 * Postgres). `scripts/test-pg.sh` provides the container + DB_DIALECT=pg.
 */
import { describe, it, expect } from "vitest";
import type { Job } from "pg-boss";
import { cloneTemplate } from "../../storage/pg/test-template.js";
import { sanitizeQueueName } from "./supervisor.js";

const isPg = process.env.DB_DIALECT === "pg";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * A started boss, or nothing left running.
 *
 * `start()` opens a pool, so a throw from it has to stop what it opened:
 * otherwise the caller's `finally` drops a database that still has
 * connections, and one failure becomes two with the second louder.
 */
async function makeBoss(url: string) {
  const { PgBoss } = await import("pg-boss");
  const boss = new PgBoss({ connectionString: url, max: 2 });
  boss.on("error", () => {
    // Maintenance errors surface on 'error'; swallowed so an emit after
    // the test's own teardown cannot crash the runner.
  });
  try {
    await boss.start();
  } catch (err) {
    await boss.stop({ graceful: false, timeout: 1_000 }).catch(() => {
      // Already failing; the original error is the one worth raising.
    });
    throw err;
  }
  return boss;
}

describe("sanitizeQueueName", () => {
  it("maps characters outside pg-boss's allowed set to underscore", () => {
    // The pre-fix schedule prefix used a ':' — rejected by pg-boss 12.
    expect(sanitizeQueueName("marfa.integrations.local.schedule:rss")).toBe(
      "marfa.integrations.local.schedule_rss",
    );
    // Valid names (dots, hyphens, the identifier's slash) pass through
    // unchanged — pg-boss admits `/`, which is why an integration name can
    // carry its namespace into a queue name without translation.
    expect(
      sanitizeQueueName("marfa.integrations.local.schedule.google/calendar"),
    ).toBe("marfa.integrations.local.schedule.google/calendar");
    expect(sanitizeQueueName("name with spaces")).toBe("name_with_spaces");
  });
});

describe.skipIf(!isPg)("pg-boss 12 local-runtime integration", () => {
  it("constructs via the named export, accepts schedule-shaped names, and round-trips a job", async () => {
    const clone = await cloneTemplate();
    // pg-boss 12 is ESM with a named PgBoss export (no default) — the same
    // import shape index.ts uses to boot the local runtime.
    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss(clone.url);
    boss.on("error", () => {
      // pg-boss surfaces maintenance errors on 'error'; swallow so an
      // unhandled emit can't crash the test runner.
    });
    try {
      await boss.start();
      // A schedule-shaped name (post-fix: dots, no colon). The ':' form threw
      // "Name can only contain ..." before the fix.
      const queue = "marfa.integrations.local.schedule.test-integration";
      await boss.createQueue(queue);
      const received: unknown[] = [];
      await boss.work(
        queue,
        { batchSize: 1, pollingIntervalSeconds: 1 },
        (jobs: Job<{ hello: string }>[]) => {
          for (const job of jobs) received.push(job.data);
          return Promise.resolve();
        },
      );
      await boss.send(queue, { hello: "world" });
      while (received.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(received).toEqual([{ hello: "world" }]);
    } finally {
      await boss.stop({ graceful: false });
      await clone.drop();
    }
  }, 30_000);
});

/**
 * The dispatch worker's throw-retry rule reads `retryCount` off the job to
 * tell a first delivery from a redelivery: a throw on the first earns one
 * retry, a throw on a redelivery goes terminal instead of burning the whole
 * ladder. The value arrives because the `work` call asks for metadata.
 *
 * That is a property of pg-boss rather than of this repository, and it is
 * exactly the kind a minor version can move without saying so. It already
 * did: 12.21 removed the dedicated overload for `includeMetadata: true` and
 * folded it into one that resolves the handler's job type from the options
 * object. Naming a single type argument on the call stops inference for the
 * rest, so the handler typed as though metadata had never been asked for.
 * The compiler said the property did not exist. It did.
 *
 * The repair was a typing change, which is the reason for this test: a
 * typing change proves nothing about what arrives at runtime, and the next
 * move might not be a typing change.
 */
describe.skipIf(!isPg)(
  "a redelivery is distinguishable from a first delivery",
  () => {
    it("carries a retry count that starts at zero and increments", async () => {
      const clone = await cloneTemplate();
      try {
        const boss = await makeBoss(clone.url);
        try {
          const queue = "retry-count-probe";
          await boss.createQueue(queue, { policy: "standard" });

          const seen: number[] = [];
          await boss.work(
            queue,
            {
              batchSize: 1,
              pollingIntervalSeconds: 0.5,
              includeMetadata: true,
            },
            async (jobs: { retryCount: number }[]) => {
              for (const job of jobs) {
                seen.push(job.retryCount);
                // Throw on the first delivery only, which is the shape the
                // dispatch worker's rule is written against.
                if (seen.length === 1) throw new Error("transient");
              }
              return Promise.resolve();
            },
          );

          await boss.send(queue, {}, { retryLimit: 1, retryDelay: 0 });
          while (seen.length < 2) {
            await sleep(250);
          }

          expect(seen.length).toBeGreaterThanOrEqual(2);
          expect(seen[0]).toBe(0);
          expect(seen[1]).toBeGreaterThan(0);
        } finally {
          await boss.stop({ graceful: false, timeout: 5_000 });
        }
      } finally {
        await clone.drop();
      }
    }, 30_000);
  },
);
