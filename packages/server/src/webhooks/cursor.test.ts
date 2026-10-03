import { unregisterTypeSchema } from "@withmarfa/shared";
import { join } from "node:path";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { registerHousekeepingJobs } from "../housekeeping/registrations.js";
import { WebhookScheduler } from "./delivery.js";

let ctx: TestContext;
let scheduler: WebhookScheduler;
let hits: number;
beforeEach(async () => {
  ctx = await createTestContext({ maxRequestBytes: 20 * 1024 * 1024 });
  initEventLog(ctx.storage.eventLog);
  hits = 0;
  scheduler = new WebhookScheduler({
    storage: ctx.storage,
    http: {
      post: () => {
        hits++;
        return Promise.resolve({
          kind: "answered",
          status: 200,
          retryAfter: null,
        } as const);
      },
    },
  });
});
afterEach(async () => {
  __resetEventLogForTests();
  unregisterTypeSchema("demo.cursor_payload");
  await ctx.cleanup();
});
async function subscribe() {
  const response = await request(ctx.app, "POST", "/webhooks", {
    key: ctx.workingKey,
    body: { url: "https://receiver.example/hook", events: ["item.created"] },
  });
  expect(response.status).toBe(201);
  const wire = (await response.json()) as { id: string };
  expect(wire).not.toHaveProperty("event_start_id");
  return wire.id;
}
async function write() {
  const response = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "cursor witness" } },
  });
  expect(response.status).toBe(201);
}
async function subscriptions(count: number) {
  for (let n = 0; n < count; n++) await subscribe();
  return ctx.storage.outboundWebhooks.listAfter(null, count);
}
async function largeWrite(bytes: number) {
  const type = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: {
      id: "demo.cursor_payload",
      label: "Cursor payload",
      version: 1,
      fields: { body: { type: "string", maxLength: 12 * 1024 * 1024 } },
    },
  });
  expect(type.status).toBe(201);
  const response = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "demo.cursor_payload",
      properties: { body: "x".repeat(bytes) },
    },
  });
  expect(response.status).toBe(201);
}
async function queued(id: string) {
  return (await ctx.storage.outboundWebhookDeliveries.list(id, { limit: 100 }))
    .data;
}

describe("durable outbound event acknowledgement", () => {
  it("recovers a failed lookup without advancing or losing its event", async () => {
    const id = await subscribe();
    await write();
    const list = ctx.storage.outboundWebhooks.listAfter.bind(
      ctx.storage.outboundWebhooks,
    );
    ctx.storage.outboundWebhooks.listAfter = () =>
      Promise.reject(new Error("lookup interrupted"));
    await expect(scheduler.runOnce()).rejects.toThrow("lookup interrupted");
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      0n,
    );
    expect(await queued(id)).toHaveLength(0);
    ctx.storage.outboundWebhooks.listAfter = list;
    expect((await scheduler.runOnce()).scheduled).toBe(1);
    expect(hits).toBe(1);
  });
  it("rolls back partial fan-out and acknowledgement together", async () => {
    const first = await subscribe();
    const second = await subscribe();
    await write();
    const schedule = ctx.storage.outboundWebhookDeliveries.schedule.bind(
      ctx.storage.outboundWebhookDeliveries,
    );
    let calls = 0;
    ctx.storage.outboundWebhookDeliveries.schedule = async (input) => {
      if (++calls === 2) throw new Error("insert interrupted");
      return schedule(input);
    };
    await expect(scheduler.runOnce()).rejects.toThrow("insert interrupted");
    expect(await queued(first)).toHaveLength(0);
    expect(await queued(second)).toHaveLength(0);
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      0n,
    );
    expect(hits).toBe(0);
    ctx.storage.outboundWebhookDeliveries.schedule = schedule;
    expect((await scheduler.runOnce()).scheduled).toBe(2);
  });
  it("does not duplicate committed rows after a lost commit response", async () => {
    const id = await subscribe();
    await write();
    const transaction = ctx.storage.runInTransaction.bind(ctx.storage);
    ctx.storage.runInTransaction = async (work) => {
      await transaction(work);
      throw new Error("commit response lost");
    };
    await expect(scheduler.runOnce()).rejects.toThrow("commit response lost");
    ctx.storage.runInTransaction = transaction;
    expect(await queued(id)).toHaveLength(1);
    expect(hits).toBe(0);
    expect((await scheduler.runOnce()).scheduled).toBe(0);
    expect(await queued(id)).toHaveLength(1);
  });
  it("excludes pre-subscription history while draining lagged events", async () => {
    const old = await subscribe();
    await write();
    const born = await subscribe();
    expect((await scheduler.runOnce()).scheduled).toBe(1);
    expect(await queued(old)).toHaveLength(1);
    expect(await queued(born)).toHaveLength(0);
    await write();
    expect((await scheduler.runOnce()).scheduled).toBe(2);
  });
  it("drains logged no-fanout events without scheduling", async () => {
    await subscribe();
    const id = await ctx.storage.eventLog.append({
      event_type: "created",
      payload: "{}",
      enable_fanout: false,
    });
    expect((await scheduler.runOnce()).scheduled).toBe(0);
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      id,
    );
  });
  it("refuses an ahead checkpoint without resetting it", async () => {
    await ctx.storage.runInTransaction(() =>
      ctx.storage.outboundWebhooks.acknowledge({
        lastEventId: 1n,
        eventId: null,
        afterSubscriptionId: null,
      }),
    );
    await expect(scheduler.runOnce()).rejects.toThrow("ahead");
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      1n,
    );
  });
  it("refuses a retention gap without advancing", async () => {
    await ctx.storage.eventLog.append({
      event_type: "created",
      payload: "{}",
      enable_fanout: false,
    });
    await ctx.storage.eventLog.append({
      event_type: "created",
      payload: "{}",
      enable_fanout: false,
    });
    await ctx.storage.eventLog.cleanup(-1);
    await expect(scheduler.runOnce()).rejects.toThrow("retention");
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      0n,
    );
  });
  it("serializes competing schedulers without duplicate queue rows", async () => {
    const id = await subscribe();
    await write();
    const results = await Promise.all([
      scheduler.runOnce(),
      scheduler.runOnce(),
    ]);
    expect(results.reduce((sum, result) => sum + result.scheduled, 0)).toBe(1);
    expect(await queued(id)).toHaveLength(1);
    expect(hits).toBe(1);
  });
  it("stores birth and checkpoint IDs without number conversion", async () => {
    const id = 9_007_199_254_740_993n;
    const head = ctx.storage.eventLog.getMaxId.bind(ctx.storage.eventLog);
    ctx.storage.eventLog.getMaxId = () => Promise.resolve(id);
    const subscription = await subscribe();
    expect(
      (await ctx.storage.outboundWebhooks.get(subscription))?.event_start_id,
    ).toBe(id);
    await ctx.storage.runInTransaction(() =>
      ctx.storage.outboundWebhooks.acknowledge({
        lastEventId: id,
        eventId: null,
        afterSubscriptionId: null,
      }),
    );
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      id,
    );
    ctx.storage.eventLog.getMaxId = head;
  });
  it("considers only one retained event in a pass", async () => {
    for (let n = 0; n < 2; n++)
      await ctx.storage.eventLog.append({
        event_type: "created",
        payload: "{}",
        enable_fanout: false,
      });
    expect((await scheduler.runOnce()).cursor).toBe("1");
    expect((await scheduler.runOnce()).cursor).toBe("2");
  });
  it("never opens HTTP before its queue and checkpoint commit", async () => {
    const id = await subscribe();
    await write();
    let committed = false;
    const transaction = ctx.storage.runInTransaction.bind(ctx.storage);
    ctx.storage.runInTransaction = async (work) => {
      const result = await transaction(work);
      committed = true;
      return result;
    };
    const checked = new WebhookScheduler({
      storage: ctx.storage,
      http: {
        post: async () => {
          expect(committed).toBe(true);
          expect(await queued(id)).toHaveLength(1);
          expect(
            (await ctx.storage.outboundWebhooks.checkpoint()).lastEventId,
          ).toBe(1n);
          hits++;
          return { kind: "answered", status: 200, retryAfter: null };
        },
      },
    });
    await checked.runOnce();
    expect(hits).toBe(1);
  });
  it("reports ahead state as a failed scheduling job", async () => {
    await ctx.storage.runInTransaction(() =>
      ctx.storage.outboundWebhooks.acknowledge({
        lastEventId: 1n,
        eventId: null,
        afterSubscriptionId: null,
      }),
    );
    registerHousekeepingJobs(
      ctx.housekeeping,
      ctx.storage,
      ctx.blobs,
      ctx.config,
    );
    await ctx.housekeeping.start();
    const result = await ctx.housekeeping.runNow("webhook-schedule");
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran") throw new Error("job did not run");
    expect(result.run.outcome).toBe("error");
    expect(result.run.error).toContain("ahead");
    expect(
      (await ctx.storage.housekeeping.get("webhook-schedule"))?.last_outcome,
    ).toBe("error");
    await ctx.housekeeping.stop();
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      1n,
    );
  });
  it("refuses missing state on a populated instance", async () => {
    await write();
    const raw = ctx.storage as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun("DELETE FROM outbound_webhook_checkpoint", []);
    await expect(scheduler.runOnce()).rejects.toThrow("missing");
    await expect(ctx.storage.outboundWebhooks.checkpoint()).rejects.toThrow(
      "missing",
    );
  });
  it("refuses a subscription birth ahead of the local log", async () => {
    await subscribe();
    const raw = ctx.storage as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    await write();
    await raw.__sqliteRun("UPDATE outbound_webhooks SET event_start_id = ?", [
      "2",
    ]);
    await expect(scheduler.runOnce()).rejects.toThrow(
      "subscription starts ahead",
    );
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      0n,
    );
  });
  it("uses current subscription configuration for unscheduled events", async () => {
    const id = await subscribe();
    await write();
    await ctx.storage.outboundWebhooks.update(id, { active: false });
    expect((await scheduler.runOnce()).scheduled).toBe(0);
    expect(await queued(id)).toHaveLength(0);
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      1n,
    );
  });
  it("does not acknowledge an inconsistent logged frame", async () => {
    await subscribe();
    await ctx.storage.eventLog.append({ event_type: "created", payload: "{}" });
    await expect(scheduler.runOnce()).rejects.toThrow("inconsistent");
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      0n,
    );
  });
  it("saves an exactly full page until a bounded next read proves exhaustion", async () => {
    const rows = await subscriptions(50);
    await write();
    const first = await scheduler.runOnce();
    expect(first.examined).toBe(50);
    expect(first.scheduled).toBe(50);
    expect(await ctx.storage.outboundWebhooks.checkpoint()).toEqual({
      lastEventId: 0n,
      eventId: 1n,
      afterSubscriptionId: rows[49]?.id,
    });
    const next = await scheduler.runOnce();
    expect(next.examined).toBe(0);
    expect(next.scheduled).toBe(0);
    expect(next.cursor).toBe("1");
  });
  it("makes durable progress through skip-only subscription pages", async () => {
    const rows = await subscriptions(51);
    for (const row of rows)
      await ctx.storage.outboundWebhooks.update(row.id, { active: false });
    await write();
    const first = await scheduler.runOnce();
    expect(first.examined).toBe(50);
    expect(first.scheduled).toBe(0);
    expect(first.cursor).toBe("0");
    await ctx.storage.outboundWebhooks.update(rows[0]!.id, { active: true });
    const next = await scheduler.runOnce();
    expect(await queued(rows[0]!.id)).toHaveLength(0);
    expect(next.examined).toBe(1);
    expect(next.scheduled).toBe(0);
    expect(next.cursor).toBe("1");
  });
  it("uses the immutable position through deletion, configuration changes and new births", async () => {
    const rows = await subscriptions(53);
    await write();
    await scheduler.runOnce();
    await ctx.storage.outboundWebhooks.update(rows[0]!.id, { active: false });
    await ctx.storage.outboundWebhooks.delete(rows[50]!.id);
    await ctx.storage.outboundWebhooks.update(rows[51]!.id, { active: false });
    await ctx.storage.outboundWebhooks.update(rows[52]!.id, {
      events: ["item.deleted"],
    });
    const newborn = await subscribe();
    const next = await scheduler.runOnce();
    expect(next.examined).toBe(3);
    expect(next.scheduled).toBe(0);
    expect(next.cursor).toBe("1");
    expect(await queued(rows[0]!.id)).toHaveLength(1);
    expect(await queued(newborn)).toHaveLength(0);
    expect(hits).toBe(50);
  });
  it("rolls back a failed partial page without moving its committed position", async () => {
    const rows = await subscriptions(53);
    await write();
    await scheduler.runOnce();
    const before = await ctx.storage.outboundWebhooks.checkpoint();
    const schedule = ctx.storage.outboundWebhookDeliveries.schedule.bind(
      ctx.storage.outboundWebhookDeliveries,
    );
    let calls = 0;
    ctx.storage.outboundWebhookDeliveries.schedule = async (input) => {
      if (++calls === 2) throw new Error("partial insert interrupted");
      return schedule(input);
    };
    await expect(scheduler.runOnce()).rejects.toThrow(
      "partial insert interrupted",
    );
    expect(await ctx.storage.outboundWebhooks.checkpoint()).toEqual(before);
    expect(await queued(rows[50]!.id)).toHaveLength(0);
    ctx.storage.outboundWebhookDeliveries.schedule = schedule;
    expect((await scheduler.runOnce()).scheduled).toBe(3);
    expect(hits).toBe(53);
  });
  it("resumes a committed partial page after its commit response is lost", async () => {
    const rows = await subscriptions(51);
    await write();
    const transaction = ctx.storage.runInTransaction.bind(ctx.storage);
    ctx.storage.runInTransaction = async (work) => {
      await transaction(work);
      throw new Error("partial commit response lost");
    };
    await expect(scheduler.runOnce()).rejects.toThrow(
      "partial commit response lost",
    );
    ctx.storage.runInTransaction = transaction;
    expect(
      (await ctx.storage.outboundWebhooks.checkpoint()).afterSubscriptionId,
    ).toBe(rows[49]?.id);
    expect((await scheduler.runOnce()).scheduled).toBe(1);
    for (const row of rows) expect(await queued(row.id)).toHaveLength(1);
  });
  it("serializes partial drains from separate SQLite connections", async () => {
    const rows = await subscriptions(51);
    await write();
    const other = await createSqliteStorage(join(ctx.tmpDir, "test.db"));
    try {
      const second = new WebhookScheduler({
        storage: other,
        http: {
          post: () =>
            Promise.resolve({
              kind: "answered",
              status: 200,
              retryAfter: null,
            } as const),
        },
      });
      const results = await Promise.all([
        scheduler.runOnce(),
        second.runOnce(),
      ]);
      expect(results.reduce((sum, result) => sum + result.scheduled, 0)).toBe(
        51,
      );
      expect(
        (await ctx.storage.outboundWebhooks.checkpoint()).lastEventId,
      ).toBe(1n);
      for (const row of rows) expect(await queued(row.id)).toHaveLength(1);
    } finally {
      await other.close();
    }
  });
  it("refuses retention loss of an unfinished event without discarding partial progress", async () => {
    const rows = await subscriptions(51);
    await write();
    await scheduler.runOnce();
    const before = await ctx.storage.outboundWebhooks.checkpoint();
    await ctx.storage.eventLog.append({
      event_type: "created",
      payload: "{}",
      enable_fanout: false,
    });
    await ctx.storage.eventLog.cleanup(-1);
    await expect(scheduler.runOnce()).rejects.toThrow("retention");
    expect(await ctx.storage.outboundWebhooks.checkpoint()).toEqual(before);
    expect(await queued(rows[49]!.id)).toHaveLength(1);
    expect(await queued(rows[50]!.id)).toHaveLength(0);
  });
  it("stops before the next delivery crosses the copied payload target", async () => {
    const rows = await subscriptions(3);
    await largeWrite(3 * 1024 * 1024);
    const first = await scheduler.runOnce();
    expect(first.examined).toBe(2);
    expect(first.scheduled).toBe(2);
    expect(first.cursor).toBe("0");
    expect(
      (await ctx.storage.outboundWebhooks.checkpoint()).afterSubscriptionId,
    ).toBe(rows[1]?.id);
    const next = await scheduler.runOnce();
    expect(next.examined).toBe(1);
    expect(next.scheduled).toBe(1);
    expect(next.cursor).toBe("1");
  });
  it("lets one accepted oversized payload progress without a validity cap", async () => {
    await subscriptions(2);
    await largeWrite(9 * 1024 * 1024);
    const first = await scheduler.runOnce();
    expect(first.examined).toBe(1);
    expect(first.scheduled).toBe(1);
    expect(first.cursor).toBe("0");
    const next = await scheduler.runOnce();
    expect(next.examined).toBe(1);
    expect(next.scheduled).toBe(1);
    expect(next.cursor).toBe("1");
    expect(hits).toBe(2);
  });
  it("refuses an inconsistent partial checkpoint rather than advancing", async () => {
    const raw = ctx.storage as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      "UPDATE outbound_webhook_checkpoint SET event_id = ?",
      ["2"],
    );
    await expect(scheduler.runOnce()).rejects.toThrow(
      "checkpoint is inconsistent",
    );
    await expect(ctx.storage.outboundWebhooks.checkpoint()).rejects.toThrow(
      "checkpoint is inconsistent",
    );
  });
});
