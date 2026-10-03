import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InStatement } from "@libsql/client";
import {
  createTestContext,
  request,
  readSseWriting,
  type TestContext,
} from "../test-utils.js";
import { BulkActionWorker } from "./worker.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { sqliteRequestContext } from "../storage/sqlite/request-context.js";
import type { BulkActionResult, BulkActionInput } from "./types.js";

const fault = vi.hoisted(
  (): { mode: "none" | "before" | "after"; fired: boolean } => ({
    mode: "none",
    fired: false,
  }),
);
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      const execute = client.execute.bind(client);
      client.execute = async (
        statement: InStatement | string,
        ...rest: unknown[]
      ) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const target =
          sql.toUpperCase() === "COMMIT" &&
          !fault.fired &&
          fault.mode !== "none";
        if (target && fault.mode === "before") {
          fault.fired = true;
          throw new Error("commit acknowledgment witness");
        }
        const result = await execute(statement, ...(rest as []));
        if (target && fault.mode === "after") {
          fault.fired = true;
          throw new Error("commit acknowledgment witness");
        }
        return result;
      };
      return client;
    },
  };
});
let ctx: TestContext;
let keyId: string;
let clock: number;
beforeEach(async () => {
  fault.mode = "none";
  fault.fired = false;
  clock = Date.now();
  ctx = await createTestContext();
  keyId = (
    (await (
      await request(ctx.app, "GET", "/keys/current", { key: ctx.workingKey })
    ).json()) as { id: string }
  ).id;
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  fault.mode = "none";
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});
function rawStorage() {
  return ctx.storage as typeof ctx.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    __sqliteAll(sql: string): Promise<Record<string, unknown>[]>;
  };
}
function barrier() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function note(body: string): Promise<string> {
  const response = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { item: { id: string } }).item.id;
}
async function queue(
  ids: string[],
  input: BulkActionInput = {
    action: "update_properties",
    patch: { body: "bulk changed" },
  },
) {
  return ctx.storage.bulkActionJobs.create({
    id: "job",
    api_key_id: keyId,
    credential: keyId,
    action: input.action,
    input: JSON.stringify(input),
    matched_ids: JSON.stringify(ids),
    matched_count: ids.length,
    created_at: new Date(clock).toISOString(),
  });
}
function worker(chunkSize = 1) {
  return new BulkActionWorker({
    storage: ctx.storage,
    workerId: "recovery-owner",
    chunkSize,
    nowFn: () => new Date(clock),
    staleAfterMs: 60000,
  });
}
async function patch(id: string, body = "ordinary changed") {
  const response = await request(ctx.app, "PATCH", `/items/${id}`, {
    key: ctx.workingKey,
    body: {
      version: (await ctx.storage.items.get(id))!.version,
      properties: { body },
    },
  });
  expect(response.status).toBe(200);
}
async function edge(parent: string, child: string) {
  expect(
    (
      await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: { source_id: parent, target_id: child, edge_type: "parent-of" },
      })
    ).status,
  ).toBe(201);
}
function armCommit(mode: "before" | "after") {
  const jobs = ctx.storage.bulkActionJobs;
  const checkpoint = jobs.checkpointChunk.bind(jobs);
  return vi
    .spyOn(jobs, "checkpointChunk")
    .mockImplementation(async (...args) => {
      const result = await checkpoint(...args);
      fault.mode = mode;
      return result;
    });
}
async function events(cursor: bigint) {
  return ctx.storage.eventLog.getAfter(cursor, 100);
}

it("rolls back rows, events, announcements and checkpoint together before recording a failed slice", async () => {
  const ids = [await note("first"), await note("second")];
  await queue(ids);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  const checkpoint = ctx.storage.bulkActionJobs.checkpointChunk.bind(
    ctx.storage.bulkActionJobs,
  );
  let failed = false;
  vi.spyOn(ctx.storage.bulkActionJobs, "checkpointChunk").mockImplementation(
    async (...args) => {
      const result = await checkpoint(...args);
      if (!failed) {
        failed = true;
        throw new Error("checkpoint rollback witness");
      }
      return result;
    },
  );
  const response = await request(ctx.app, "GET", "/events", {
    key: ctx.workingKey,
    headers: { "Last-Event-ID": String(cursor) },
  });
  const { text } = await readSseWriting(
    response,
    "event: stream_live",
    async () => {
      expect(await worker().runOnce()).toBe(true);
    },
    (seen) => seen.includes(ids[1]!),
  );
  expect(text).not.toContain(ids[0]!);
  expect((await ctx.storage.items.get(ids[0]!))?.properties.body).toBe("first");
  expect((await ctx.storage.items.get(ids[1]!))?.properties.body).toBe(
    "bulk changed",
  );
  expect((await events(cursor)).map((e) => e.item_id)).toEqual([ids[1]]);
  const done = await ctx.storage.bulkActionJobs.getById("job");
  expect(done).toMatchObject({
    status: "completed",
    next_offset: 2,
    processed_count: 2,
    succeeded_count: 1,
    errored_count: 1,
  });
  expect(
    (JSON.parse(done!.result!) as BulkActionResult).errors![0]!.message,
  ).toContain("checkpoint rollback witness");
});

it.each(["before", "after"] as const)(
  "reconciles a native %s-COMMIT acknowledgment fault without replaying committed rows",
  async (mode) => {
    const ids = [await note("first"), await note("second")];
    const before = await Promise.all(
      ids.map((id) => ctx.storage.items.get(id)),
    );
    await queue(ids);
    const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    armCommit(mode);
    expect(await worker().runOnce()).toBe(true);
    expect(fault.fired).toBe(true);
    const after = await Promise.all(ids.map((id) => ctx.storage.items.get(id)));
    expect(after.map((row, n) => row!.version - before[n]!.version)).toEqual(
      mode === "after" ? [1, 1] : [0, 1],
    );
    expect((await events(cursor)).map((e) => e.item_id)).toEqual(
      mode === "after" ? ids : [ids[1]],
    );
    expect(await ctx.storage.bulkActionJobs.getById("job")).toMatchObject({
      status: "completed",
      next_offset: 2,
      succeeded_count: mode === "after" ? 2 : 1,
      errored_count: mode === "after" ? 0 : 1,
    });
  },
);

it("leaves an unreadable commit outcome for a later owner to resume at the durable cursor", async () => {
  const ids = [await note("first"), await note("second")];
  const before = await Promise.all(ids.map((id) => ctx.storage.items.get(id)));
  await queue(ids);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  const arm = armCommit("after");
  const get = ctx.storage.bulkActionJobs.getById.bind(
    ctx.storage.bulkActionJobs,
  );
  const unavailable = vi
    .spyOn(ctx.storage.bulkActionJobs, "getById")
    .mockImplementation(async (id) => {
      if (fault.fired) throw new Error("state unavailable witness");
      return get(id);
    });
  expect(await worker().runOnce()).toBe(true);
  arm.mockRestore();
  unavailable.mockRestore();
  expect(await get("job")).toMatchObject({
    status: "in_progress",
    next_offset: 1,
    succeeded_count: 1,
  });
  expect((await ctx.storage.items.get(ids[1]!))?.version).toBe(
    before[1]!.version,
  );
  clock += 65000;
  expect(await worker().runOnce()).toBe(true);
  expect(
    (await Promise.all(ids.map((id) => ctx.storage.items.get(id)))).map(
      (row, n) => row!.version - before[n]!.version,
    ),
  ).toEqual([1, 1]);
  expect((await events(cursor)).map((e) => e.item_id)).toEqual(ids);
  expect(await get("job")).toMatchObject({
    status: "completed",
    next_offset: 2,
    succeeded_count: 2,
    errored_count: 0,
  });
});

it("does not attempt a later slice until its owned failure checkpoint commits", async () => {
  const ids = [await note("first"), await note("second")];
  await queue(ids);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  const blocked = vi
    .spyOn(ctx.storage.bulkActionJobs, "checkpointChunk")
    .mockRejectedValue(new Error("checkpoint unavailable witness"));
  expect(await worker().runOnce()).toBe(true);
  expect(await ctx.storage.bulkActionJobs.getById("job")).toMatchObject({
    status: "in_progress",
    next_offset: 0,
    processed_count: 0,
  });
  expect(await events(cursor)).toHaveLength(0);
  expect((await ctx.storage.items.get(ids[1]!))?.properties.body).toBe(
    "second",
  );
  blocked.mockRestore();
  clock += 65000;
  expect(await worker().runOnce()).toBe(true);
  expect((await events(cursor)).map((e) => e.item_id)).toEqual(ids);
});

it("a rolled-back cascade does not leak carried membership into its later child slice", async () => {
  const parent = await note("parent"),
    child = await note("child");
  await edge(parent, child);
  await queue([parent, child], { action: "transition", state: "trashed" });
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  const checkpoint = ctx.storage.bulkActionJobs.checkpointChunk.bind(
    ctx.storage.bulkActionJobs,
  );
  let failed = false;
  vi.spyOn(ctx.storage.bulkActionJobs, "checkpointChunk").mockImplementation(
    async (...args) => {
      const result = await checkpoint(...args);
      if (!failed) {
        failed = true;
        throw new Error("cascade checkpoint rollback witness");
      }
      return result;
    },
  );
  expect(await worker().runOnce()).toBe(true);
  expect((await ctx.storage.items.getIncludingTrashed(parent))?.state).toBe(
    "active",
  );
  expect((await ctx.storage.items.getIncludingTrashed(child))?.state).toBe(
    "trashed",
  );
  expect((await events(cursor)).map((e) => e.item_id)).toEqual([child]);
  expect(await ctx.storage.bulkActionJobs.carriedItems("job", [child])).toEqual(
    new Set(),
  );
  expect(await ctx.storage.bulkActionJobs.getById("job")).toMatchObject({
    succeeded_count: 1,
    errored_count: 1,
    next_offset: 2,
  });
});

it("resumes a carried child without writing or announcing its transition twice", async () => {
  const parent = await note("parent"),
    child = await note("child");
  await edge(parent, child);
  const before = await ctx.storage.items.getIncludingTrashed(child);
  await queue([parent, child], { action: "transition", state: "trashed" });
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  const arm = armCommit("after");
  const get = ctx.storage.bulkActionJobs.getById.bind(
    ctx.storage.bulkActionJobs,
  );
  const blocked = vi
    .spyOn(ctx.storage.bulkActionJobs, "getById")
    .mockImplementation(async (id) => {
      if (fault.fired) throw new Error("state unavailable witness");
      return get(id);
    });
  expect(await worker().runOnce()).toBe(true);
  arm.mockRestore();
  blocked.mockRestore();
  expect(await ctx.storage.bulkActionJobs.carriedItems("job", [child])).toEqual(
    new Set([child]),
  );
  const committedChild = await ctx.storage.items.getIncludingTrashed(child);
  expect(committedChild?.state).toBe("trashed");
  expect(committedChild?.version).toBe(before!.version);
  clock += 65000;
  expect(await worker().runOnce()).toBe(true);
  expect((await ctx.storage.items.getIncludingTrashed(child))?.version).toBe(
    committedChild!.version,
  );
  expect(
    (await events(cursor)).filter((e) => e.item_id === child),
  ).toHaveLength(1);
  expect(await get("job")).toMatchObject({
    status: "completed",
    next_offset: 2,
    succeeded_count: 2,
  });
});

it("polling exposes committed counters and omits every private checkpoint and ownership field", async () => {
  const id = await note("one");
  await queue([id]);
  expect(await worker().runOnce()).toBe(true);
  const stored = await ctx.storage.bulkActionJobs.getById("job");
  expect(stored).toMatchObject({
    claim_generation: 1,
    next_offset: 1,
    worker_id: "recovery-owner",
  });
  expect(stored!.checkpoint_json).toContain("ids");
  const response = await request(
    ctx.app,
    "GET",
    "/items/bulk-actions/jobs/job",
    {
      key: ctx.workingKey,
    },
  );
  expect(response.status).toBe(200);
  const wire = (await response.json()) as Record<string, unknown>;
  expect(wire).toMatchObject({
    status: "completed",
    processed: 1,
    succeeded: 1,
  });
  for (const name of [
    "claim_generation",
    "next_offset",
    "worker_id",
    "worker_heartbeat_at",
    "checkpoint_json",
    "matched_ids",
    "blob_hashes_referenced_count",
  ])
    expect(wire).not.toHaveProperty(name);
});

it("a live SSE subscriber receives the original reconciled frame before a later ordinary event", async () => {
  const ids = [await note("bulk"), await note("ordinary")];
  await queue([ids[0]!]);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  armCommit("after");
  const response = await request(ctx.app, "GET", "/events", {
    key: ctx.workingKey,
    headers: { "Last-Event-ID": String(cursor) },
  });
  const { text } = await readSseWriting(
    response,
    "event: stream_live",
    async () => {
      expect(await worker().runOnce()).toBe(true);
      await patch(ids[1]!);
    },
    (seen) => seen.includes(ids[1]!),
  );
  const durable = await events(cursor);
  expect(durable.map((e) => e.item_id)).toEqual(ids);
  expect(text.indexOf(ids[0]!)).toBeLessThan(text.indexOf(ids[1]!));
  for (const event of durable)
    expect(text.split(`id: ${String(event.id)}\n`)).toHaveLength(2);
  expect(text).not.toContain("stream_incomplete");
});

it("holds a later committed writer's announcement behind an uncertain earlier frame", async () => {
  const ids = [await note("bulk"), await note("ordinary")];
  await queue([ids[0]!]);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  armCommit("after");
  const transaction = ctx.storage.runInTransaction.bind(ctx.storage);
  const reached = barrier(),
    release = barrier();
  let delayed = false;
  vi.spyOn(ctx.storage, "runInTransaction").mockImplementation(
    async (fn, options) => {
      if (fault.fired && !delayed && !sqliteRequestContext.getStore()) {
        delayed = true;
        reached.resolve();
        await release.promise;
      }
      return transaction(fn, options);
    },
  );
  const response = await request(ctx.app, "GET", "/events", {
    key: ctx.workingKey,
    headers: { "Last-Event-ID": String(cursor) },
  });
  const { text } = await readSseWriting(
    response,
    "event: stream_live",
    async () => {
      const running = worker().runOnce();
      await reached.promise;
      try {
        await patch(ids[1]!);
        expect((await events(cursor)).map((e) => e.item_id)).toEqual(ids);
      } finally {
        release.resolve();
      }
      expect(await running).toBe(true);
    },
    (seen) => seen.includes(ids[1]!),
  );
  expect(text.indexOf(ids[0]!)).toBeLessThan(text.indexOf(ids[1]!));
  for (const event of await events(cursor))
    expect(text.split(`id: ${String(event.id)}\n`)).toHaveLength(2);
});

it("unreadable reconciliation ends an already live subscriber explicitly while later writes remain usable", async () => {
  const ids = [await note("bulk"), await note("ordinary")];
  await queue([ids[0]!]);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  armCommit("after");
  const get = ctx.storage.bulkActionJobs.getById.bind(
    ctx.storage.bulkActionJobs,
  );
  const blocked = vi
    .spyOn(ctx.storage.bulkActionJobs, "getById")
    .mockImplementation(async (id) => {
      if (fault.fired) throw new Error("state unavailable witness");
      return get(id);
    });
  const response = await request(ctx.app, "GET", "/events", {
    key: ctx.workingKey,
    headers: { "Last-Event-ID": String(cursor) },
  });
  const { text } = await readSseWriting(
    response,
    "event: stream_live",
    async () => {
      expect(await worker().runOnce()).toBe(true);
      blocked.mockRestore();
      await patch(ids[1]!);
    },
    (seen) => seen.includes("stream_incomplete"),
  );
  expect(text).toContain('"reason":"live_delivery_failed"');
  expect(text).not.toContain(ids[1]!);
  expect((await events(cursor)).map((e) => e.item_id)).toEqual(ids);
});

it("ownership changing after an uncertain commit ends live delivery and leaves later writes usable", async () => {
  const ids = [
    await note("bulk first"),
    await note("bulk second"),
    await note("ordinary"),
  ];
  await queue(ids.slice(0, 2));
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  const jobs = ctx.storage.bulkActionJobs;
  const checkpoint = jobs.checkpointChunk.bind(jobs);
  vi.spyOn(jobs, "checkpointChunk").mockImplementation(async (...args) => {
    const result = await checkpoint(...args);
    fault.mode = "after";
    return result;
  });
  const get = jobs.getById.bind(jobs);
  let canceled = false;
  vi.spyOn(jobs, "getById").mockImplementation(async (id) => {
    if (fault.fired && !canceled) {
      canceled = true;
      expect(await jobs.cancel("job", new Date(clock + 1).toISOString())).toBe(
        true,
      );
    }
    return get(id);
  });
  const response = await request(ctx.app, "GET", "/events", {
    key: ctx.workingKey,
    headers: { "Last-Event-ID": String(cursor) },
  });
  const { text } = await readSseWriting(
    response,
    "event: stream_live",
    async () => {
      expect(await worker().runOnce()).toBe(true);
      expect(await jobs.getById("job")).toMatchObject({
        status: "canceled",
        next_offset: 1,
        succeeded_count: 1,
      });
      expect(
        (
          await request(ctx.app, "PATCH", `/items/${ids[2]!}`, {
            key: ctx.workingKey,
            body: {
              version: (await ctx.storage.items.get(ids[2]!))!.version,
              properties: { body: "ordinary changed" },
            },
          })
        ).status,
      ).toBe(200);
    },
    (accumulated) => accumulated.includes("stream_incomplete"),
  );
  expect(text).toContain('"reason":"live_delivery_failed"');
  expect(text).not.toContain(ids[2]!);
  expect(
    (await ctx.storage.eventLog.getAfter(cursor, 20)).map(
      (event) => event.item_id,
    ),
  ).toEqual([ids[0], ids[2]]);
  expect((await ctx.storage.items.get(ids[1]!))?.properties.body).toBe(
    "bulk second",
  );
});

it("bounds a retained uncertain announcement frame while ordinary writers continue committing", async () => {
  const ids = [await note("bulk"), await note("ordinary")];
  await queue([ids[0]!]);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  const checkpoint = ctx.storage.bulkActionJobs.checkpointChunk.bind(
    ctx.storage.bulkActionJobs,
  );
  vi.spyOn(ctx.storage.bulkActionJobs, "checkpointChunk").mockImplementation(
    async (...args) => {
      const result = await checkpoint(...args);
      fault.mode = "after";
      return result;
    },
  );
  const transaction = ctx.storage.runInTransaction.bind(ctx.storage);
  const reached = barrier(),
    release = barrier();
  let delayed = false;
  vi.spyOn(ctx.storage, "runInTransaction").mockImplementation(
    async (fn, options) => {
      if (fault.fired && !delayed && !sqliteRequestContext.getStore()) {
        delayed = true;
        reached.resolve();
        await release.promise;
      }
      return transaction(fn, options);
    },
  );
  const response = await request(ctx.app, "GET", "/events", {
    key: ctx.workingKey,
    headers: { "Last-Event-ID": String(cursor) },
  });
  const { text } = await readSseWriting(
    response,
    "event: stream_live",
    async () => {
      const running = worker().runOnce();
      await reached.promise;
      try {
        for (let n = 0; n < 70; n++)
          expect(
            (
              await request(ctx.app, "PATCH", `/items/${ids[1]!}`, {
                key: ctx.workingKey,
                body: {
                  version: (await ctx.storage.items.get(ids[1]!))!.version,
                  properties: { body: `ordinary ${String(n)}` },
                },
              })
            ).status,
          ).toBe(200);
      } finally {
        release.resolve();
      }
      expect(await running).toBe(true);
    },
    (accumulated) => accumulated.includes("stream_incomplete"),
  );
  expect(text).toContain('"reason":"live_delivery_failed"');
  expect(text).not.toContain(ids[1]!);
  const events = await ctx.storage.eventLog.getAfter(cursor, 100);
  expect(events.filter((event) => event.item_id === ids[0])).toHaveLength(1);
  expect(events.filter((event) => event.item_id === ids[1])).toHaveLength(70);
  expect(await ctx.storage.bulkActionJobs.getById("job")).toMatchObject({
    status: "completed",
    succeeded_count: 1,
  });
});

it("records a definitely aborted chunk at its old cursor with the native cause before attempting the next chunk", async () => {
  const ids = [
    await note("first"),
    await note("ends transaction"),
    await note("last"),
  ];
  const before = await Promise.all(ids.map((id) => ctx.storage.items.get(id)));
  await rawStorage().__sqliteRun(
    `CREATE TRIGGER ends_bulk BEFORE UPDATE OF properties ON items WHEN OLD.id = '${ids[1]!}' BEGIN SELECT RAISE(ROLLBACK, 'native bulk rollback witness'); END`,
    [],
  );
  await queue(ids);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  expect(await worker(2).runOnce()).toBe(true);
  const done = await ctx.storage.bulkActionJobs.getById("job");
  expect(done).toMatchObject({
    status: "completed",
    next_offset: 3,
    processed_count: 3,
    succeeded_count: 1,
    errored_count: 2,
  });
  const result = JSON.parse(done!.result!) as {
    errors: { id: string; message: string; code: string }[];
  };
  expect(result.errors.map((e) => e.id)).toEqual(ids.slice(0, 2));
  for (const error of result.errors) {
    expect(error.code).toBe("internal_error");
    expect(error.message).toContain("native bulk rollback witness");
    expect(error.message).not.toContain("params:");
    expect(error.message).not.toContain("update ");
  }
  expect(
    (await Promise.all(ids.map((id) => ctx.storage.items.get(id)))).map(
      (row, n) => row!.version - before[n]!.version,
    ),
  ).toEqual([0, 0, 1]);
  expect((await events(cursor)).map((e) => e.item_id)).toEqual([ids[2]]);
});

it("preserves a unique referenced-hash count across purge resume even when surviving rows share a hash", async () => {
  const shared = "sha256:" + "a".repeat(64),
    other = "sha256:" + "b".repeat(64);
  const survivor = await note(shared);
  const ids = [
    await note(shared + " " + shared),
    await note(shared),
    await note(other),
  ];
  for (const id of ids)
    expect(
      (
        await request(ctx.app, "POST", `/items/${id}/transition`, {
          key: ctx.workingKey,
          body: { state: "trashed" },
        })
      ).status,
    ).toBe(200);
  await queue(ids, { action: "purge", confirm: "PURGE" });
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  const arm = armCommit("after");
  const get = ctx.storage.bulkActionJobs.getById.bind(
    ctx.storage.bulkActionJobs,
  );
  const blocked = vi
    .spyOn(ctx.storage.bulkActionJobs, "getById")
    .mockImplementation(async (id) => {
      if (fault.fired) throw new Error("state unavailable witness");
      return get(id);
    });
  expect(await worker().runOnce()).toBe(true);
  arm.mockRestore();
  blocked.mockRestore();
  expect(await get("job")).toMatchObject({
    next_offset: 1,
    blob_hashes_referenced_count: 1,
  });
  expect(
    await rawStorage().__sqliteAll(
      "SELECT hash FROM bulk_action_job_purge_hashes WHERE job_id = 'job'",
    ),
  ).toEqual([{ hash: shared }]);
  clock += 65000;
  expect(await worker().runOnce()).toBe(true);
  const done = await get("job");
  expect(done).toMatchObject({
    status: "completed",
    succeeded_count: 3,
    errored_count: 0,
    next_offset: 3,
    blob_hashes_referenced_count: 2,
  });
  expect(
    (JSON.parse(done!.result!) as BulkActionResult).blob_hashes_referenced,
  ).toBe(2);
  for (const id of ids)
    expect(await ctx.storage.items.getIncludingTrashed(id)).toBeNull();
  expect((await ctx.storage.items.get(survivor))?.properties.body).toBe(shared);
  expect((await events(cursor)).map((e) => e.item_id)).toEqual(ids);
  expect(
    await rawStorage().__sqliteAll(
      "SELECT hash FROM bulk_action_job_purge_hashes WHERE job_id = 'job' ORDER BY hash",
    ),
  ).toEqual([{ hash: shared }, { hash: other }]);
});

it("a noncommitted acknowledgment failure discards its frame and leaves a live subscriber receiving later writes", async () => {
  const ids = [await note("bulk"), await note("ordinary")];
  await queue([ids[0]!]);
  const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  armCommit("before");
  const response = await request(ctx.app, "GET", "/events", {
    key: ctx.workingKey,
    headers: { "Last-Event-ID": String(cursor) },
  });
  const { text } = await readSseWriting(
    response,
    "event: stream_live",
    async () => {
      expect(await worker().runOnce()).toBe(true);
      await patch(ids[1]!);
    },
    (seen) => seen.includes(ids[1]!),
  );
  expect(text).not.toContain(ids[0]!);
  expect(text).not.toContain("stream_incomplete");
  expect((await events(cursor)).map((e) => e.item_id)).toEqual([ids[1]]);
});
