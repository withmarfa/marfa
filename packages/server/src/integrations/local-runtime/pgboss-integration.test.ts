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
import { cloneTemplate } from "../../storage/pg/test-template.js";
import { sanitizeQueueName } from "./supervisor.js";

const isPg = process.env.DB_DIALECT === "pg";

describe("sanitizeQueueName", () => {
  it("maps characters outside pg-boss's allowed set to underscore", () => {
    // The pre-fix schedule prefix used a ':' — rejected by pg-boss 12.
    expect(sanitizeQueueName("marfa.integrations.local.schedule:rss")).toBe(
      "marfa.integrations.local.schedule_rss",
    );
    // Valid names (dots, hyphens) pass through unchanged.
    expect(
      sanitizeQueueName("marfa.integrations.local.schedule.google.calendar"),
    ).toBe("marfa.integrations.local.schedule.google.calendar");
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
      await boss.work<{ hello: string }>(
        queue,
        { batchSize: 1, pollingIntervalSeconds: 1 },
        (jobs) => {
          for (const job of jobs) received.push(job.data);
          return Promise.resolve();
        },
      );
      await boss.send(queue, { hello: "world" });
      const deadline = Date.now() + 15_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(received).toEqual([{ hello: "world" }]);
    } finally {
      await boss.stop({ graceful: false });
      await clone.drop();
    }
  }, 30_000);
});
