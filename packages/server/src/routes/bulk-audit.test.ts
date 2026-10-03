import { afterEach, beforeEach, expect, it } from "vitest";
import { generateId } from "@withmarfa/shared";
import {
  createTestContext,
  request,
  collectItemEvents,
  collectEdgeEvents,
  settle,
  type TestContext,
} from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { setBulkJobEnqueueListener } from "../bulk-actions/enqueue-signal.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  setBulkJobEnqueueListener(null);
  __resetEventLogForTests();
  await ctx.cleanup();
});
async function sql(statement: string) {
  return (
    ctx.storage as typeof ctx.storage & {
      __sqliteRun(s: string, args: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(statement, []);
}
async function note() {
  const r = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "seed" } },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string } }).item.id;
}
async function entries(family: "items" | "edges", count: number) {
  const result = [];
  for (let i = 0; i < count; i++)
    result.push(
      family === "items"
        ? {
            id: generateId(),
            type: "core.note",
            properties: { body: `entry${String(i)}` },
          }
        : {
            id: generateId(),
            source_id: await note(),
            target_id: await note(),
            edge_type: "about",
          },
    );
  return result;
}
async function post(
  family: "items" | "edges",
  atomic: boolean,
  rows: unknown[],
) {
  return request(ctx.app, "POST", `/${family}/bulk`, {
    key: ctx.workingKey,
    body: { atomic, [family]: rows },
  });
}

it.each(["items", "edges"] as const)(
  "couples an atomic %s page to its single aggregate audit",
  async (family) => {
    const control = await entries(family, 2);
    expect((await post(family, true, control)).status).toBe(200);
    const audit = await ctx.storage.audit.list({ action: `${family}.bulk` });
    expect(audit.data).toHaveLength(1);
    expect(audit.data[0]?.details).toMatchObject({ atomic: true, created: 2 });
    const rejected = await entries(family, 2),
      head = await ctx.storage.eventLog.getMaxId();
    await sql(
      `CREATE TRIGGER reject_bulk_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${family}.bulk' BEGIN SELECT RAISE(ABORT, 'audit refused'); END`,
    );
    expect((await post(family, true, rejected)).status).toBe(500);
    for (const row of rejected)
      expect(await ctx.storage[family].get(row.id)).toBeNull();
    expect(await ctx.storage.eventLog.getMaxId()).toBe(head);
    expect(
      (await ctx.storage.audit.list({ action: `${family}.bulk` })).data,
    ).toHaveLength(1);
  },
);

it.each(["items", "edges"] as const)(
  "keeps earlier and later %s entries and their audits when one best-effort audit fails",
  async (family) => {
    const rows = await entries(family, 3);
    const abort = new AbortController(),
      itemEvents = collectItemEvents(abort.signal),
      edgeEvents = collectEdgeEvents(abort.signal);
    try {
      await sql(
        `CREATE TRIGGER reject_bulk_entry BEFORE INSERT ON audit_log WHEN NEW.action = '${family}.bulk' AND json_extract(NEW.details, '$.index') = 1 BEGIN SELECT RAISE(ABORT, 'entry audit refused'); END`,
      );
      const res = await post(family, false, rows);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        counts: unknown;
        results: { outcome: string }[];
      };
      expect(body.counts).toEqual({
        created: 2,
        updated: 0,
        skipped: 0,
        errored: 1,
      });
      expect(body.results.map((r) => r.outcome)).toEqual([
        "created",
        "errored",
        "created",
      ]);
      for (const [index, row] of rows.entries())
        expect(await ctx.storage[family].get(row.id)).toEqual(
          index === 1 ? null : expect.objectContaining({ id: row.id }),
        );
      const audit = await ctx.storage.audit.list({ action: `${family}.bulk` });
      expect(audit.data).toHaveLength(2);
      expect(new Set(audit.data.map((r) => r.details.operation_id)).size).toBe(
        1,
      );
      expect(audit.data.map((r) => r.details.index).sort()).toEqual([0, 2]);
      await settle();
      const seen =
        family === "items"
          ? itemEvents.events.map((e) => e.item.id)
          : edgeEvents.events.map((e) => e.edge.id);
      expect(seen.sort()).toEqual([rows[0]!.id, rows[2]!.id].sort());
    } finally {
      abort.abort();
      await Promise.all([itemEvents.done, edgeEvents.done]);
    }
  },
);

it("commits enqueue before wake and audits only accepted cancellation transitions", async () => {
  const id = await note();
  let wakes = 0;
  setBulkJobEnqueueListener(() => {
    wakes++;
  });
  const enqueue = () =>
    request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      body: {
        action: "update_tags",
        add: ["after"],
        filter: { type: "core.note" },
      },
    });
  const positive = await enqueue();
  expect(positive.status).toBe(202);
  const job = (await positive.json()) as { id: string };
  expect(wakes).toBe(1);
  expect(
    (await ctx.storage.audit.list({ action: "items.bulk_action" })).data,
  ).toHaveLength(1);
  await sql(
    "CREATE TRIGGER reject_enqueue BEFORE INSERT ON audit_log WHEN NEW.action = 'items.bulk_action' BEGIN SELECT RAISE(ABORT, 'enqueue audit refused'); END",
  );
  expect((await enqueue()).status).toBe(500);
  expect(wakes).toBe(1);
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteAll(s: string): Promise<unknown[]>;
  };
  expect(await raw.__sqliteAll("SELECT id FROM bulk_action_jobs")).toEqual([
    { id: job.id },
  ]);
  const cancel = () =>
    request(ctx.app, "DELETE", `/items/bulk-actions/jobs/${job.id}`, {
      key: ctx.workingKey,
    });
  await sql(
    "CREATE TRIGGER reject_cancel BEFORE INSERT ON audit_log WHEN NEW.action = 'items.bulk_action.cancel' BEGIN SELECT RAISE(ABORT, 'cancel audit refused'); END",
  );
  expect((await cancel()).status).toBe(500);
  expect((await ctx.storage.bulkActionJobs.getById(job.id))?.status).toBe(
    "queued",
  );
  await sql("DROP TRIGGER reject_cancel");
  expect((await cancel()).status).toBe(200);
  expect((await cancel()).status).toBe(200);
  expect(
    (
      await ctx.storage.audit.list({
        action: "items.bulk_action.cancel",
        resource_id: job.id,
      })
    ).data,
  ).toHaveLength(1);
  expect(await ctx.storage.items.get(id)).not.toBeNull();
});

import { BulkActionWorker } from "../bulk-actions/worker.js";
it("audits fenced worker chunks with their rows, events and checkpoints", async () => {
  const ids = [await note(), await note(), await note()];
  const res = await request(ctx.app, "POST", "/items/bulk-actions", {
    key: ctx.workingKey,
    body: {
      action: "update_tags",
      add: ["processed"],
      filter: { type: "core.note" },
    },
  });
  expect(res.status).toBe(202);
  const job = (await res.json()) as { id: string };
  const frozen = (await ctx.storage.bulkActionJobs.getById(job.id))!;
  const order = JSON.parse(frozen.matched_ids) as string[];
  expect(new Set(order)).toEqual(new Set(ids));
  await sql(
    "CREATE TRIGGER reject_chunk BEFORE INSERT ON audit_log WHEN NEW.action = 'items.bulk_action.chunk' AND json_extract(NEW.details, '$.from_offset') = 1 BEGIN SELECT RAISE(ABORT, 'chunk audit refused'); END",
  );
  const abort = new AbortController(),
    live = collectItemEvents(abort.signal);
  const worker = new BulkActionWorker({ storage: ctx.storage, chunkSize: 1 });
  try {
    await worker.runOnce();
    const after = await ctx.storage.bulkActionJobs.getById(job.id);
    expect(after).toMatchObject({
      status: "completed",
      next_offset: 3,
      processed_count: 3,
      succeeded_count: 2,
      errored_count: 1,
    });
    for (const [index, id] of order.entries())
      expect((await ctx.storage.metadata.get(id)).tags).toEqual(
        index === 1 ? [] : ["processed"],
      );
    const audit = (
      await ctx.storage.audit.list({
        action: "items.bulk_action.chunk",
        resource_id: job.id,
      })
    ).data;
    expect(audit).toHaveLength(2);
    expect(audit.map((r) => r.details.from_offset).sort()).toEqual([0, 2]);
    await settle();
    expect(live.events.map((e) => e.item.id).sort()).toEqual(
      [order[0], order[2]].sort(),
    );
    await worker.runOnce();
    expect(
      (
        await ctx.storage.audit.list({
          action: "items.bulk_action.chunk",
          resource_id: job.id,
        })
      ).data,
    ).toHaveLength(2);
  } finally {
    worker.stop();
    abort.abort();
    await live.done;
  }
});
