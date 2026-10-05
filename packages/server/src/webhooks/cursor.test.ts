import { unregisterTypeSchema } from "@withmarfa/shared";
import { join } from "node:path";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { registerBackgroundJobs } from "../background-jobs/registrations.js";
import { WebhookPoller, WebhookScheduler } from "./delivery.js";

let ctx: TestContext;
let scheduler: WebhookScheduler;
let wakes: number;
beforeEach(async () => {
  ctx = await createTestContext({ maxRequestBytes: 20 * 1024 * 1024 });
  initEventLog(ctx.storage.eventLog);
  wakes = 0;
  scheduler = new WebhookScheduler({
    storage: ctx.storage,
    wakePoller: () => {
      wakes++;
      return Promise.resolve();
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
function quietPayload(): string {
  return JSON.stringify({
    event_type: "item.created",
    item: {
      id: "quiet",
      type: "core.note",
      state: "active",
      properties: {},
      version: 1,
      schema_version: 1,
      source: "test",
      occurred_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
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
    expect(wakes).toBe(1);
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
    expect(wakes).toBe(0);
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
    expect(wakes).toBe(0);
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
      payload: quietPayload(),
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
      payload: quietPayload(),
      enable_fanout: false,
    });
    await ctx.storage.eventLog.append({
      event_type: "created",
      payload: quietPayload(),
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
    expect(wakes).toBe(1);
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
  it("bounds consecutive no-fanout events by the fetched-event budget", async () => {
    for (let n = 0; n < 129; n++)
      await ctx.storage.eventLog.append({
        event_type: "created",
        payload: quietPayload(),
        enable_fanout: false,
      });
    const first = await scheduler.runOnce();
    expect(first.fetched).toBe(128);
    expect(first.cursor).toBe("128");
    expect(first.scheduled).toBe(0);
    expect((await scheduler.runOnce()).cursor).toBe("129");
  });
  it("excludes valid pre-birth subscriptions while draining consecutive events", async () => {
    for (let n = 0; n < 100; n++) await write();
    const id = await subscribe();
    await write();
    const result = await scheduler.runOnce();
    expect(result.examined).toBe(1);
    expect(result.scheduled).toBe(1);
    expect(result.cursor).toBe("101");
    expect(await queued(id)).toHaveLength(1);
  });
  it("selects births numerically at decimal-width and adjacent bigint boundaries", async () => {
    const rows = await subscriptions(4);
    const raw = ctx.storage as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    async function births(values: string[]) {
      for (let n = 0; n < values.length; n++)
        await raw.__sqliteRun(
          "UPDATE outbound_webhooks SET event_start_id = ? WHERE id = ?",
          [values[n], rows[n]!.id],
        );
    }
    await births(["9", "10", "99", "100"]);
    expect(
      (
        await ctx.storage.outboundWebhooks.listAfter(null, 50, {
          eventId: 10n,
          headId: 100n,
        })
      ).map((row) => row.id),
    ).toEqual([rows[0]!.id]);
    expect(
      (
        await ctx.storage.outboundWebhooks.listAfter(null, 50, {
          eventId: 100n,
          headId: 100n,
        })
      ).map((row) => row.id),
    ).toEqual(rows.slice(0, 3).map((row) => row.id));
    await births([
      "9007199254740992",
      "9007199254740993",
      "9007199254740994",
      "9007199254740995",
    ]);
    expect(
      (
        await ctx.storage.outboundWebhooks.listAfter(null, 50, {
          eventId: 9007199254740993n,
          headId: 9007199254740995n,
        })
      ).map((row) => row.id),
    ).toEqual([rows[0]!.id]);
  });
  it("includes malformed, negative, overflow and ahead births for visible validation", async () => {
    const id = await subscribe();
    const raw = ctx.storage as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    };
    for (const birth of ["01", "99junk", "-1", "9223372036854775808"]) {
      await raw.__sqliteRun(
        "UPDATE outbound_webhooks SET event_start_id = ? WHERE id = ?",
        [birth, id],
      );
      await expect(
        ctx.storage.outboundWebhooks.listAfter(null, 50, {
          eventId: 1n,
          headId: 9223372036854775807n,
        }),
      ).rejects.toThrow("Invalid outbound webhook event checkpoint");
    }
    await raw.__sqliteRun(
      "UPDATE outbound_webhooks SET event_start_id = ? WHERE id = ?",
      ["100", id],
    );
    expect(
      (
        await ctx.storage.outboundWebhooks.listAfter(null, 50, {
          eventId: 1n,
          headId: 99n,
        })
      ).map((row) => row.id),
    ).toEqual([id]);
  });
  it("bounds examined rows and deliveries across multiple events", async () => {
    const rows = await subscriptions(30);
    await write();
    await write();
    const first = await scheduler.runOnce();
    expect(first.examined).toBe(50);
    expect(first.scheduled).toBe(50);
    expect(first.cursor).toBe("1");
    expect(first.event).toBe("2");
    expect(wakes).toBe(1);
    const next = await scheduler.runOnce();
    expect(next.examined).toBe(10);
    expect(next.scheduled).toBe(10);
    expect(next.cursor).toBe("2");
    for (const row of rows) expect(await queued(row.id)).toHaveLength(2);
  });
  it("rolls back earlier events when a later retained frame is malformed", async () => {
    const id = await subscribe();
    await write();
    await ctx.storage.eventLog.append({
      event_type: "created",
      payload: JSON.stringify({ event_type: "item.created", item: null }),
      enable_fanout: true,
    });
    await expect(scheduler.runOnce()).rejects.toThrow("inconsistent");
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      0n,
    );
    expect(await queued(id)).toHaveLength(0);
    expect(wakes).toBe(0);
  });
  it("bounds scanned bytes across skip-only events without stalling an oversized first event", async () => {
    const frame = JSON.parse(quietPayload()) as {
      item: { properties: { body?: string } };
    };
    frame.item.properties.body = "x".repeat(5 * 1024 * 1024);
    for (let n = 0; n < 2; n++)
      await ctx.storage.eventLog.append({
        event_type: "created",
        payload: JSON.stringify(frame),
        enable_fanout: false,
      });
    const first = await scheduler.runOnce();
    expect(first.fetched).toBe(2);
    expect(first.scannedBytes).toBeLessThan(8 * 1024 * 1024);
    expect(first.cursor).toBe("1");
    expect((await scheduler.runOnce()).cursor).toBe("2");
    frame.item.properties.body = "x".repeat(9 * 1024 * 1024);
    await ctx.storage.eventLog.append({
      event_type: "created",
      payload: JSON.stringify(frame),
      enable_fanout: false,
    });
    await ctx.storage.eventLog.append({
      event_type: "created",
      payload: quietPayload(),
      enable_fanout: false,
    });
    const oversized = await scheduler.runOnce();
    expect(oversized.fetched).toBe(1);
    expect(oversized.scannedBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(oversized.cursor).toBe("3");
    expect((await scheduler.runOnce()).cursor).toBe("4");
  });
  it("bounds copied bytes across completed consecutive events", async () => {
    await subscribe();
    await subscribe();
    await largeWrite(3 * 1024 * 1024);
    const [event] = await ctx.storage.eventLog.getAfter(0n, 1);
    if (!event) throw new Error("ordinary large event is missing");
    await ctx.storage.eventLog.append({
      event_type: "created",
      payload: event.payload,
      enable_fanout: true,
    });
    const first = await scheduler.runOnce();
    expect(first.scheduled).toBe(2);
    expect(first.queuedBytes).toBeLessThan(8 * 1024 * 1024);
    expect(first.cursor).toBe("1");
    expect(first.event).toBe("2");
    const next = await scheduler.runOnce();
    expect(next.scheduled).toBe(2);
    expect(next.cursor).toBe("2");
  });
  it("wakes the poller only after its queue and checkpoint commit", async () => {
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
      wakePoller: async () => {
        expect(committed).toBe(true);
        expect(await queued(id)).toHaveLength(1);
        expect(
          (await ctx.storage.outboundWebhooks.checkpoint()).lastEventId,
        ).toBe(1n);
        wakes++;
      },
    });
    await checked.runOnce();
    expect(wakes).toBe(1);
  });
  it("keeps a committed queue and cursor when the poll wake fails", async () => {
    const id = await subscribe();
    await write();
    const refused = new WebhookScheduler({
      storage: ctx.storage,
      wakePoller: () => Promise.reject(new Error("wake refusal witness")),
    });
    await expect(refused.runOnce()).rejects.toThrow("wake refusal witness");
    expect(await queued(id)).toHaveLength(1);
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      1n,
    );
    expect((await scheduler.runOnce()).scheduled).toBe(0);
    expect(await queued(id)).toHaveLength(1);
    const attempt = await new WebhookPoller({
      storage: ctx.storage,
      http: {
        post: () =>
          Promise.resolve({ kind: "answered", status: 200, retryAfter: null }),
      },
    }).runOnce();
    expect(attempt.attempted).toBe(1);
    expect((await queued(id))[0]).toMatchObject({
      status: "success",
      attempt: 1,
    });
  });
  it("reports ahead state as a failed scheduling job", async () => {
    await ctx.storage.runInTransaction(() =>
      ctx.storage.outboundWebhooks.acknowledge({
        lastEventId: 1n,
        eventId: null,
        afterSubscriptionId: null,
      }),
    );
    registerBackgroundJobs(
      ctx.backgroundJobs,
      ctx.storage,
      ctx.blobs,
      ctx.config,
    );
    await ctx.backgroundJobs.start();
    const result = await ctx.backgroundJobs.runNow("webhook-schedule");
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran") throw new Error("job did not run");
    expect(result.run.outcome).toBe("error");
    expect(result.run.error).toContain("ahead");
    expect(
      (await ctx.storage.backgroundJobs.get("webhook-schedule"))?.last_outcome,
    ).toBe("error");
    await ctx.backgroundJobs.stop();
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
    expect(next.examined).toBe(2);
    expect(next.scheduled).toBe(0);
    expect(next.cursor).toBe("1");
    expect(await queued(rows[0]!.id)).toHaveLength(1);
    expect(await queued(newborn)).toHaveLength(0);
    expect(wakes).toBe(1);
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
    expect(wakes).toBe(2);
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
        wakePoller: () => Promise.resolve(),
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
      payload: quietPayload(),
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
    expect(wakes).toBe(2);
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
  it.each([
    {
      name: "null item",
      eventType: "created",
      frame: { event_type: "item.created", item: null },
    },
    {
      name: "null no-fanout item",
      eventType: "created",
      frame: { event_type: "item.created", item: null },
      fanout: false,
    },
    {
      name: "incomplete item",
      eventType: "created",
      frame: { event_type: "item.created", item: { type: "core.note" } },
    },
    {
      name: "edge in an item event",
      eventType: "created",
      frame: { event_type: "item.created", edge: {} },
    },
    {
      name: "null edge",
      eventType: "edge_created",
      frame: { event_type: "edge.created", edge: null },
    },
    {
      name: "incomplete edge",
      eventType: "edge_created",
      frame: { event_type: "edge.created", edge: { edge_type: "references" } },
    },
    {
      name: "unknown discriminator",
      eventType: "unknown",
      frame: { event_type: "item.unknown", item: {} },
    },
    {
      name: "mismatched discriminator",
      eventType: "created",
      // A valid item, so the discriminator alone makes the frame invalid.
      frame: {
        event_type: "item.deleted",
        item: {
          id: "01HMISMATCHMISMATCHMISMAT0",
          type: "core.note",
          version: 1,
          state: "active",
          tier: "library",
          source: "test",
          schema_version: 1,
          occurred_at: "2026-01-01T00:00:00.000Z",
          properties: { title: "mismatch" },
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  ])(
    "fails the scheduling job on a $name without acknowledging it",
    async ({ eventType, frame, ...options }) => {
      await subscribe();
      await write();
      expect((await scheduler.runOnce()).scheduled).toBe(1);
      expect(wakes).toBe(1);
      const before = await ctx.storage.outboundWebhooks.checkpoint();
      await ctx.storage.eventLog.append({
        event_type: eventType,
        payload: JSON.stringify(frame),
        enable_fanout: "fanout" in options ? options.fanout : true,
      });
      registerBackgroundJobs(
        ctx.backgroundJobs,
        ctx.storage,
        ctx.blobs,
        ctx.config,
      );
      await ctx.backgroundJobs.start();
      try {
        const result = await ctx.backgroundJobs.runNow("webhook-schedule");
        expect(result.kind).toBe("ran");
        if (result.kind !== "ran") throw new Error("job did not run");
        expect(result.run.outcome).toBe("error");
        expect(result.run.error).toContain("payload is inconsistent");
        expect(await ctx.storage.outboundWebhooks.checkpoint()).toEqual(before);
        expect(
          (await ctx.storage.backgroundJobs.get("webhook-schedule"))
            ?.last_outcome,
        ).toBe("error");
      } finally {
        await ctx.backgroundJobs.stop();
      }
    },
  );
  it("acknowledges a valid denied-reach frame as a successful skip", async () => {
    const key = await mintWorkingKey(ctx, {
      permissions: ["webhooks.manage"],
      type_permissions: { "core.task": "read" },
    });
    const subscribed = await request(ctx.app, "POST", "/webhooks", {
      key,
      body: { url: "https://receiver.example/hook", events: ["item.created"] },
    });
    expect(subscribed.status).toBe(201);
    const { id } = (await subscribed.json()) as { id: string };
    await write();
    registerBackgroundJobs(
      ctx.backgroundJobs,
      ctx.storage,
      ctx.blobs,
      ctx.config,
    );
    await ctx.backgroundJobs.start();
    try {
      const result = await ctx.backgroundJobs.runNow("webhook-schedule");
      expect(result.kind).toBe("ran");
      if (result.kind !== "ran") throw new Error("job did not run");
      expect(result.run.outcome).toBe("ok");
      expect(result.run.result?.scheduled).toBe(0);
      expect(
        (await ctx.storage.outboundWebhooks.checkpoint()).lastEventId,
      ).toBe(1n);
      expect(await queued(id)).toHaveLength(0);
    } finally {
      await ctx.backgroundJobs.stop();
    }
  });
});
