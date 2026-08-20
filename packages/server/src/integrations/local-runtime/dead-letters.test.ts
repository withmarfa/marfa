/**
 * Dead-letter ops against a real pg-boss on a real Postgres.
 *
 * The route tests stub the ops layer; this suite is the acceptance
 * check for the primitives themselves: a deliberately failed dispatch
 * appears in the listing with its recorded reason, envelope fields,
 * attempt count and timestamps; replay flips exactly that job back to
 * the retry state exactly once; a second replay is refused with a 409
 * naming the job's actual state; an unknown id answers 404.
 *
 * The failure is manufactured with pg-boss's own fetch + fail — the
 * same two calls its work loop makes around a throwing handler — so
 * the state transitions are the production ones without a polling
 * worker in the test.
 *
 * PG-only: the local substrate requires Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { MarfaError } from "@withmarfa/shared";
import {
  cloneTemplate,
  type PgTemplateClone,
} from "../../storage/pg/test-template.js";
import type { PgDb } from "../../storage/pg/connection.js";
import { createDeadLetterOps, type DeadLetterOps } from "./dead-letters.js";
import { QUEUE_NAME } from "./supervisor.js";
import type { PgBoss as PgBossType } from "pg-boss";

const isPg = process.env.DB_DIALECT === "pg";

describe.skipIf(!isPg)("dead-letter ops (real pg-boss)", () => {
  let clone: PgTemplateClone;
  let boss: PgBossType;
  let client: ReturnType<typeof postgres>;
  let ops: DeadLetterOps;

  const envelope = {
    integration_name: "rss-watcher",
    message: {
      kind: "schedule",
      connection_id: "conn-dead-letter-test",
      space_id: "space-1",
    },
  };

  beforeAll(async () => {
    clone = await cloneTemplate();
    const { PgBoss } = await import("pg-boss");
    boss = new PgBoss(clone.url);
    boss.on("error", () => {
      // pg-boss surfaces maintenance errors on 'error'; swallow so an
      // unhandled emit can't crash the test runner.
    });
    await boss.start();
    await boss.createQueue(QUEUE_NAME);
    client = postgres(clone.url, { max: 2 });
    // The ops only issue reads through `db.execute`; a bare drizzle
    // handle over the clone is the same shape production passes.
    ops = createDeadLetterOps(boss, drizzle(client) as unknown as PgDb);
  }, 30_000);

  afterAll(async () => {
    await boss.stop({ graceful: false });
    await client.end({ timeout: 5 });
    await clone.drop();
  });

  it("lists a failed dispatch with reason, envelope, attempts, and timestamps, then replays it exactly once", async () => {
    // retryLimit 0: the first failure is terminal, exactly the state a
    // dispatch that exhausted its ladder ends in.
    const jobId = await boss.send(QUEUE_NAME, envelope, { retryLimit: 0 });
    expect(jobId).toBeTruthy();
    const id = jobId!;

    // fetch + fail are what boss.work does around a throwing handler.
    const fetched = await boss.fetch(QUEUE_NAME, { batchSize: 10 });
    expect(fetched.map((j) => j.id)).toContain(id);
    await boss.fail(QUEUE_NAME, id, {
      message: "retryable: upstream returned 500",
    });

    const jobs = await ops.list(50);
    const row = jobs.find((j) => j.id === id);
    expect(row).toBeDefined();
    expect(row?.integration).toBe("rss-watcher");
    expect(row?.connection_id).toBe("conn-dead-letter-test");
    expect(row?.kind).toBe("schedule");
    expect(row?.reason).toBe("retryable: upstream returned 500");
    expect(row?.attempts).toBeGreaterThanOrEqual(1);
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.failed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Replay: the job leaves `failed`, so it disappears from the listing
    // and pg-boss will hand it to the dispatch worker again.
    const result = await ops.replay(id);
    expect(result).toEqual({ replayed: true, id });
    const [job] = await boss.findJobs(QUEUE_NAME, { id });
    expect(job?.state).toBe("retry");
    const afterReplay = await ops.list(50);
    expect(afterReplay.find((j) => j.id === id)).toBeUndefined();

    // A second replay finds the job no longer failed and refuses loudly,
    // naming the state it is actually in.
    await expect(ops.replay(id)).rejects.toMatchObject({
      code: "conflict",
      details: { state: "retry" },
    });
  }, 30_000);

  it("answers not_found for a job id that never existed", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const err = await ops.replay(missing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarfaError);
    expect((err as MarfaError).code).toBe("not_found");
  });

  it("orders the listing newest failure first and honors the limit", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const jobId = await boss.send(
        QUEUE_NAME,
        {
          ...envelope,
          message: {
            ...envelope.message,
            connection_id: `conn-order-${String(i)}`,
          },
        },
        { retryLimit: 0 },
      );
      ids.push(jobId!);
      const fetched = await boss.fetch(QUEUE_NAME, { batchSize: 10 });
      const mine = fetched.find((j) => j.id === jobId);
      expect(mine).toBeDefined();
      await boss.fail(QUEUE_NAME, jobId!, {
        message: `failure ${String(i)}`,
      });
      // completed_on has millisecond resolution; space the failures out
      // so the ordering assertion cannot tie.
      await new Promise((r) => setTimeout(r, 15));
    }

    const limited = await ops.list(2);
    expect(limited).toHaveLength(2);
    expect(limited[0]?.reason).toBe("failure 2");
    expect(limited[1]?.reason).toBe("failure 1");
  }, 30_000);
});
