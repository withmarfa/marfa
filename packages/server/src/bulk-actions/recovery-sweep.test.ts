import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClient, type Transaction } from "@libsql/client";
import { join } from "node:path";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { setBusyBudgetMs } from "../storage/sqlite/connection.js";
import { originalErrorMessage } from "../storage/sqlite/transaction-control.js";
import { BulkActionWorker } from "./worker.js";
import { afterBulkChunkCommit } from "./test-helpers.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  setBusyBudgetMs(0);
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});

it.each([false, true])(
  "preserves committed progress and finishes after a boundary sweep (locked: %s)",
  async (locked) => {
    const ids: string[] = [];
    for (const body of ["first", "second", "third"]) {
      const response = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body } },
      });
      expect(response.status).toBe(201);
      ids.push(((await response.json()) as { item: { id: string } }).item.id);
    }
    const keyId = (
      (await (
        await request(ctx.app, "GET", "/keys/current", { key: ctx.workingKey })
      ).json()) as { id: string }
    ).id;
    const before = await Promise.all(
      ids.map((id) => ctx.storage.items.get(id)),
    );
    const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    const jobs = ctx.storage.bulkActionJobs;
    let now = Date.now();
    const initial = now;
    await jobs.create({
      id: "active",
      api_key_id: keyId,
      credential: keyId,
      action: "update_properties",
      input: JSON.stringify({
        action: "update_properties",
        patch: { body: "updated" },
      }),
      matched_ids: JSON.stringify(ids),
      matched_count: ids.length,
      created_at: new Date(now).toISOString(),
    });
    const owner = new BulkActionWorker({
      storage: ctx.storage,
      chunkSize: 1,
      staleAfterMs: 60000,
      workerId: "active-owner",
      nowFn: () => new Date(now),
    });
    const other = createClient({ url: `file:${join(ctx.tmpDir, "test.db")}` });
    let holder: Transaction | undefined;
    let failedSweeps = 0;
    const recover = jobs.recoverStale.bind(jobs);
    vi.spyOn(jobs, "recoverStale").mockImplementation(async (cutoff) => {
      try {
        return await recover(cutoff);
      } catch (error) {
        failedSweeps++;
        expect(originalErrorMessage(error)).toContain(
          "Nothing was written; retry",
        );
        throw error;
      } finally {
        if (holder) {
          await holder.rollback();
          holder = undefined;
        }
      }
    });
    let observed = false;
    const restore = afterBulkChunkCommit(ctx.storage, async () => {
      if (observed) return;
      observed = true;
      expect(await jobs.getById("active")).toMatchObject({
        status: "in_progress",
        next_offset: 1,
        processed_count: 1,
        succeeded_count: 1,
        errored_count: 0,
        claim_generation: 1,
      });
      const polled = await request(
        ctx.app,
        "GET",
        "/items/bulk-actions/jobs/active",
        {
          key: ctx.workingKey,
        },
      );
      expect(polled.status).toBe(200);
      expect(await polled.json()).toMatchObject({
        status: "in_progress",
        processed: 1,
        succeeded: 1,
      });
      expect(
        (await ctx.storage.eventLog.getAfter(cursor, 20)).map(
          (event) => event.item_id,
        ),
      ).toEqual([ids[0]]);
      now = initial + 10000;
      if (locked) {
        holder = await other.transaction("write");
        await holder.execute(
          "UPDATE bulk_action_jobs SET error = error WHERE id = 'active'",
        );
      }
    });
    try {
      expect(await owner.runOnce()).toBe(true);
      expect(observed).toBe(true);
      expect(failedSweeps).toBe(locked ? 1 : 0);
      const done = await jobs.getById("active");
      console.log(
        "SWEEP_BOUNDARY_OBSERVED",
        JSON.stringify({ locked, failedSweeps, job: done }),
      );
      expect(done).toMatchObject({
        status: "completed",
        next_offset: 3,
        processed_count: 3,
        succeeded_count: 3,
        errored_count: 0,
        claim_generation: 1,
        worker_id: "active-owner",
        error: null,
      });
      expect(
        (await ctx.storage.eventLog.getAfter(cursor, 20)).map(
          (event) => event.item_id,
        ),
      ).toEqual(ids);
      for (const [index, id] of ids.entries())
        expect((await ctx.storage.items.get(id))!.version).toBe(
          before[index]!.version + 1,
        );
      const polled = await request(
        ctx.app,
        "GET",
        "/items/bulk-actions/jobs/active",
        { key: ctx.workingKey },
      );
      expect(polled.status).toBe(200);
      expect(await polled.json()).toMatchObject({
        status: "completed",
        processed: 3,
        succeeded: 3,
        errored: 0,
      });
    } finally {
      restore();
      if (holder) await holder.rollback();
      other.close();
      await owner.stop();
    }
  },
);

it("starts and retries failed idle recovery at the sweep cadence", async () => {
  const jobs = ctx.storage.bulkActionJobs;
  const keyId = (
    (await (
      await request(ctx.app, "GET", "/keys/current", { key: ctx.workingKey })
    ).json()) as { id: string }
  ).id;
  let now = Date.now();
  await jobs.create({
    id: "abandoned",
    api_key_id: keyId,
    credential: keyId,
    action: "update_tags",
    input: JSON.stringify({ action: "update_tags", add: ["recovered"] }),
    matched_ids: "[]",
    matched_count: 0,
    created_at: new Date(now - 65000).toISOString(),
  });
  expect(
    await jobs.claimNext("departed", new Date(now - 65000).toISOString()),
  ).not.toBeNull();
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
  };
  await raw.__sqliteRun(
    "CREATE TRIGGER refuse_recovery BEFORE UPDATE OF status ON bulk_action_jobs WHEN OLD.id = 'abandoned' AND NEW.status = 'queued' BEGIN SELECT RAISE(ABORT, 'native sweep refusal witness'); END",
    [],
  );
  const sweep = vi.spyOn(jobs, "recoverStale");
  const owner = new BulkActionWorker({
    storage: ctx.storage,
    nowFn: () => new Date(now),
    workerId: "replacement",
  });
  try {
    await owner.start();
    await owner.stop();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(await owner.runOnce()).toBe(false);
    now += 5000;
    expect(await owner.runOnce()).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(1);
    now += 5000;
    expect(await owner.runOnce()).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(await jobs.getById("abandoned")).toMatchObject({
      status: "in_progress",
      claim_generation: 1,
      worker_id: "departed",
    });
    await raw.__sqliteRun("DROP TRIGGER refuse_recovery", []);
    expect(await owner.runOnce()).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(2);
    now += 10000;
    expect(await owner.runOnce()).toBe(true);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(await jobs.getById("abandoned")).toMatchObject({
      status: "completed",
      claim_generation: 3,
      worker_id: "replacement",
      processed_count: 0,
    });
  } finally {
    await owner.stop();
  }
});
