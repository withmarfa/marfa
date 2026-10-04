import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { resolveLiveCredential } from "../auth/live-credential.js";
import type { LiveCredential } from "../auth/live-credential.js";
import { runChunk } from "./runner.js";
import { BulkActionWorker } from "./worker.js";
import { jobLease } from "./checkpoint.js";
import { sqliteRequestContext } from "../storage/sqlite/request-context.js";
import { afterBulkChunkCommit } from "./test-helpers.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

const clockBase = Date.now();
let ctx: TestContext;
let credential: LiveCredential;
let keyId: string;
const workers: BulkActionWorker[] = [];
beforeEach(async () => {
  ctx = await createTestContext();
  const current = await request(ctx.app, "GET", "/keys/current", {
    key: ctx.workingKey,
  });
  keyId = ((await current.json()) as { id: string }).id;
  const resolved = await resolveLiveCredential(ctx.storage, keyId, {
    tokenOutlivesExpiry: true,
  });
  if (!resolved) throw new Error("working credential did not resolve");
  credential = resolved;
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.useRealTimers();
  __resetEventLogForTests();
  await ctx.cleanup();
});
async function note(body: string) {
  const response = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { item: { id: string } }).item.id;
}
function rawRun(sql: string) {
  return (
    ctx.storage as unknown as {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(sql, []);
}
function chain(error: unknown): unknown[] {
  const entries: unknown[] = [];
  for (
    let step = error, i = 0;
    step && typeof step === "object" && i < 8;
    i++
  ) {
    const e = step as Error & { code?: string; cause?: unknown };
    entries.push({ name: e.name, code: e.code, message: e.message });
    step = e.cause;
  }
  return entries;
}
async function cursor() {
  return (await ctx.storage.eventLog.getMaxId()) ?? 0n;
}
async function tags(ids: string[]) {
  return Promise.all(
    ids.map(async (id) => (await ctx.storage.metadata.get(id)).tags),
  );
}
async function job(id: string, ids: string[], action = "update_tags") {
  return ctx.storage.bulkActionJobs.create({
    id,
    api_key_id: keyId,
    credential: "ordinary-witness",
    action,
    input: JSON.stringify(
      action === "update_tags"
        ? { action, add: ["checkpoint"] }
        : { action, patch: { body: "resumed" } },
    ),
    matched_ids: JSON.stringify(ids),
    matched_count: ids.length,
    created_at: new Date(clockBase).toISOString(),
  });
}
function worker(nowFn: () => Date, workerId: string) {
  const w = new BulkActionWorker({
    storage: ctx.storage,
    chunkSize: 1,
    pollIntervalMs: 10,
    maxPollIntervalMs: 20,
    staleAfterMs: 60000,
    workerId,
    nowFn,
  });
  workers.push(w);
  return w;
}
describe("bulk transaction loss and durable recovery", () => {
  it("a row-local ABORT leaves the failed row unchanged and continues", async () => {
    const ids = [
      await note("before"),
      await note("refused"),
      await note("after"),
    ];
    await rawRun(
      `CREATE TRIGGER ordinary_abort BEFORE UPDATE OF tags ON metadata WHEN OLD.item_id = '${ids[1]!}' BEGIN SELECT RAISE(ABORT, 'ordinary row refusal'); END`,
    );
    const start = await cursor();
    const result = await runChunk({
      storage: ctx.storage,
      credential,
      ids,
      input: { action: "update_tags", add: ["witness"] },
    });
    const actual = await tags(ids);
    const events = await ctx.storage.eventLog.getAfter(start, 20);
    console.log(
      "ROW_ABORT_CONTROL",
      JSON.stringify({
        succeeded: result.succeeded,
        errors: result.errors,
        tags: actual,
        logged: events.length,
      }),
    );
    expect(result.succeeded).toEqual([ids[0]!, ids[2]]);
    expect(result.errors.map((error) => error.id)).toEqual([ids[1]]);
    expect(actual).toEqual([["witness"], [], ["witness"]]);
    expect(events).toHaveLength(2);
  });
  it("transaction-ending ROLLBACK stops row attempts and preserves the original cause", async () => {
    const ids = [
      await note("before"),
      await note("ending"),
      await note("after"),
    ];
    await rawRun(
      `CREATE TRIGGER ordinary_rollback BEFORE UPDATE OF tags ON metadata WHEN OLD.item_id = '${ids[1]!}' BEGIN SELECT RAISE(ROLLBACK, 'ordinary transaction-ending witness'); END`,
    );
    const start = await cursor();
    const original = ctx.storage.runInTransaction.bind(ctx.storage);
    let rowAttempts = 0;
    const statementErrors: unknown[] = [];
    ctx.storage.runInTransaction = async (fn) => {
      if (sqliteRequestContext.getStore()) {
        rowAttempts++;
        return original(fn);
      }
      return original(async () => {
        const tx = sqliteRequestContext.getStore()!.tx as unknown as {
          session: { tx: { execute(...args: unknown[]): Promise<unknown> } };
        };
        const client = tx.session.tx;
        const execute = client.execute.bind(client);
        client.execute = async (...args) => {
          try {
            return await execute(...args);
          } catch (error) {
            const stmt = args[0] as string | { sql: string };
            statementErrors.push({
              sql: typeof stmt === "string" ? stmt : stmt.sql,
              error: chain(error),
            });
            throw error;
          }
        };
        try {
          return await fn();
        } finally {
          client.execute = execute;
        }
      });
    };
    let thrown: unknown;
    try {
      await runChunk({
        storage: ctx.storage,
        credential,
        ids,
        input: { action: "update_tags", add: ["witness"] },
      });
    } catch (error) {
      thrown = error;
    } finally {
      ctx.storage.runInTransaction = original;
    }
    const actual = await tags(ids);
    const events = await ctx.storage.eventLog.getAfter(start, 20);
    console.log(
      "TRANSACTION_END_OBSERVED",
      JSON.stringify({
        rowAttempts,
        statementErrors,
        error: chain(thrown),
        tags: actual,
        logged: events.length,
      }),
    );
    expect(
      JSON.stringify(statementErrors),
      "positive witness: SQLite raised the injected transaction-ending cause",
    ).toContain("ordinary transaction-ending witness");
    expect(thrown).toBeDefined();
    expect(actual).toEqual([[], [], []]);
    expect(events).toHaveLength(0);
    expect
      .soft(
        rowAttempts,
        "the runner must not attempt the third row after the native transaction ended",
      )
      .toBe(2);
    expect(
      JSON.stringify(chain(thrown)),
      "the caller must retain the injected original cause",
    ).toContain("ordinary transaction-ending witness");
  });
  it("a recent in_progress job recovers after its heartbeat ages while polling continues", async () => {
    await job("recent-job", []);
    await ctx.storage.bulkActionJobs.claimNext(
      "departed-worker",
      new Date(clockBase).toISOString(),
    );
    let now = new Date(clockBase + 6000);
    const jobs = ctx.storage.bulkActionJobs;
    const recover = jobs.recoverStale.bind(jobs);
    const claim = jobs.claimNext.bind(jobs);
    let recoverCalls = 0,
      claimCalls = 0;
    jobs.recoverStale = async (cutoff) => {
      recoverCalls++;
      return recover(cutoff);
    };
    jobs.claimNext = async (owner, at) => {
      claimCalls++;
      return claim(owner, at);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = worker(() => now, "replacement-worker");
    let live;
    let restarted;
    try {
      await first.start();
      await vi.advanceTimersByTimeAsync(1);
      expect((await jobs.getById("recent-job"))?.status).toBe("in_progress");
      now = new Date(clockBase + 65000);
      await vi.advanceTimersByTimeAsync(100);
      live = await jobs.getById("recent-job");
      await first.stop();
      const second = worker(() => now, "later-replacement-worker");
      await second.start();
      await vi.advanceTimersByTimeAsync(1);
      restarted = await jobs.getById("recent-job");
      await second.stop();
    } finally {
      jobs.recoverStale = recover;
      jobs.claimNext = claim;
    }
    console.log(
      "RECOVERY_OBSERVED",
      JSON.stringify({
        claimCalls,
        recoverCalls,
        whilePolling: live,
        afterLaterStart: restarted,
      }),
    );
    expect(claimCalls).toBeGreaterThan(3);
    expect(
      restarted?.status,
      "positive witness: a later start really recovers and executes this same job",
    ).toBe("completed");
    expect(
      live?.status,
      "aging the heartbeat while an existing worker polls must suffice without another start",
    ).toBe("completed");
  });
  it("a committed row and event already have their durable checkpoint", async () => {
    const id = await note("checkpoint");
    await job("checkpoint-job", [id]);
    const start = await cursor();
    const original = ctx.storage.runInTransaction.bind(ctx.storage);
    let observed:
      | {
          job: Awaited<ReturnType<typeof ctx.storage.bulkActionJobs.getById>>;
          tags: string[][];
          logged: number;
        }
      | undefined;
    ctx.storage.runInTransaction = async (fn) => {
      const root = !sqliteRequestContext.getStore();
      const result = await original(fn);
      if (root)
        observed = {
          job: await ctx.storage.bulkActionJobs.getById("checkpoint-job"),
          tags: await tags([id]),
          logged: (await ctx.storage.eventLog.getAfter(start, 20)).length,
        };
      return result;
    };
    try {
      expect(
        await worker(() => new Date(clockBase), "checkpoint-owner").runOnce(),
      ).toBe(true);
    } finally {
      ctx.storage.runInTransaction = original;
    }
    console.log("ATOMIC_CHECKPOINT_OBSERVED", JSON.stringify(observed));
    expect(observed?.tags).toEqual([["checkpoint"]]);
    expect(observed?.logged).toBe(1);
    expect(observed?.job).toMatchObject({
      status: "completed",
      next_offset: 1,
      processed_count: 1,
      succeeded_count: 1,
    });
  });
  it("recovery respects a durable processed count rather than replaying its first row", async () => {
    const ids = [await note("first"), await note("second")];
    await job("resume-job", ids, "update_properties");
    const claimed = await ctx.storage.bulkActionJobs.claimNext(
      "departed-owner",
      new Date(clockBase).toISOString(),
    );
    if (!claimed) throw new Error("fixture did not claim");
    const lease = jobLease(claimed);
    const start = await cursor();
    await ctx.storage.runInTransaction(async () => {
      expect(
        await ctx.storage.bulkActionJobs.beginChunk(
          lease,
          0,
          new Date(clockBase).toISOString(),
        ),
      ).not.toBeNull();
      const outcome = await runChunk({
        storage: ctx.storage,
        credential,
        ids: [ids[0]!],
        input: { action: "update_properties", patch: { body: "resumed" } },
      });
      await ctx.storage.bulkActionJobs.checkpointChunk(
        lease,
        0,
        1,
        outcome,
        new Date(clockBase).toISOString(),
      );
    });
    const firstBefore = await ctx.storage.items.get(ids[0]!);
    const w = worker(() => new Date(clockBase + 65000), "resumed-owner");
    expect(await w.recoverStale()).toBe(1);
    expect(
      (await ctx.storage.bulkActionJobs.getById("resume-job"))?.processed_count,
    ).toBe(1);
    expect(await w.runOnce()).toBe(true);
    const firstAfter = await ctx.storage.items.get(ids[0]!);
    const events = await ctx.storage.eventLog.getAfter(start, 20);
    const finished = await ctx.storage.bulkActionJobs.getById("resume-job");
    console.log(
      "REPLAY_OBSERVED",
      JSON.stringify({
        firstBefore: firstBefore?.version,
        firstAfter: firstAfter?.version,
        eventItemIds: events.map((event) => event.item_id),
        finished,
      }),
    );
    expect(finished?.status).toBe("completed");
    expect(finished?.succeeded_count).toBe(2);
    expect
      .soft(
        firstAfter?.version,
        "a committed earlier row must not update twice",
      )
      .toBe(firstBefore?.version);
    expect(
      events.filter((event) => event.item_id === ids[0]!),
      "an earlier committed row must have exactly one event",
    ).toHaveLength(1);
  });
  it("recovers another abandoned job between committed chunks without reclaiming the active chunk owner", async () => {
    const ids = [await note("first"), await note("second")];
    await ctx.storage.bulkActionJobs.create({
      id: "abandoned",
      api_key_id: keyId,
      credential: keyId,
      action: "update_tags",
      input: JSON.stringify({ action: "update_tags", add: ["abandoned"] }),
      matched_ids: "[]",
      matched_count: 0,
      created_at: new Date(clockBase - 55000).toISOString(),
    });
    expect(
      await ctx.storage.bulkActionJobs.claimNext(
        "departed",
        new Date(clockBase - 55000).toISOString(),
      ),
    ).not.toBeNull();
    await job("active", ids);
    let now = clockBase;
    const restored = afterBulkChunkCommit(ctx.storage, () => {
      now = clockBase + 10000;
    });
    try {
      expect(await worker(() => new Date(now), "active-owner").runOnce()).toBe(
        true,
      );
    } finally {
      restored();
    }
    expect(await ctx.storage.bulkActionJobs.getById("active")).toMatchObject({
      status: "completed",
      next_offset: 2,
      succeeded_count: 2,
      worker_id: "active-owner",
    });
    expect(await ctx.storage.bulkActionJobs.getById("abandoned")).toMatchObject(
      { status: "queued", worker_id: null, claim_generation: 2 },
    );
    expect(await worker(() => new Date(now), "replacement").runOnce()).toBe(
      true,
    );
    expect(
      (await ctx.storage.bulkActionJobs.getById("abandoned"))?.status,
    ).toBe("completed");
  });
});
