import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { unregisterTypeSchema } from "@withmarfa/shared";
import { WebhookScheduler, deliveryInReach } from "./delivery.js";
let ctx: TestContext;
let sent: Record<string, unknown>[];
let scheduler: WebhookScheduler;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  sent = [];
  scheduler = new WebhookScheduler({
    storage: ctx.storage,
    http: {
      post: (post) => {
        sent.push(JSON.parse(post.body) as Record<string, unknown>);
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
  unregisterTypeSchema("demo.declared_note");
  unregisterTypeSchema("demo.root");
  unregisterTypeSchema("demo.root.child");
  await ctx.cleanup();
});
async function api(method: string, path: string, body?: unknown) {
  const response = await request(ctx.app, method, path, {
    key: ctx.workingKey,
    body,
  });
  return { status: response.status, data: await response.json() };
}
async function hook(events = ["item.created"], type_filter?: string) {
  const response = await api("POST", "/webhooks", {
    url: "https://receiver.example/hook",
    events,
    type_filter,
  });
  expect(response.status).toBe(201);
  return response.data as { id: string };
}
async function note(type = "core.note") {
  const response = await api("POST", "/items", {
    type,
    properties: { body: "ordinary follow-up" },
  });
  expect(response.status).toBe(201);
  return (response.data as { item: { id: string } }).item;
}
describe("webhook identity, outcomes and filters", () => {
  it("carries the originating exact event and stable queue ids", async () => {
    const subscription = await hook();
    await note();
    await scheduler.runOnce();
    const page = await ctx.storage.outboundWebhookDeliveries.list(
      subscription.id,
      { limit: 10 },
    );
    expect(sent[0]).toMatchObject({
      event_id: "1",
      delivery_id: page.data[0]!.id,
    });
    expect(page.data[0]).toMatchObject({
      status: "success",
      succeeded: true,
      error: null,
    });
  });
  it("persists event ids beyond number precision without conversion", async () => {
    const subscription = await hook();
    await note();
    const [event] = await ctx.storage.eventLog.getAfter(0n, 1);
    if (!event) throw new Error("ordinary event missing");
    const exact = 9_007_199_254_740_993n;
    const id = await ctx.storage.outboundWebhookDeliveries.schedule({
      webhookId: subscription.id,
      eventId: exact,
      eventType: "item.created",
      payload: event.payload,
      webhookUrl: "https://receiver.example/hook",
      nextAttemptAt: new Date().toISOString(),
    });
    const pending = await ctx.storage.outboundWebhookDeliveries.claimById(
      id,
      new Date(Date.now() + 60000).toISOString(),
      new Date().toISOString(),
    );
    expect(pending?.event_id).toBe(exact.toString());
    if (!pending) throw new Error("pending delivery missing");
    const prepared = await deliveryInReach(ctx.storage, pending);
    expect(prepared).toHaveProperty("body");
    if (!("body" in prepared)) throw new Error("ordinary payload withheld");
    expect(JSON.parse(prepared.body) as unknown).toMatchObject({
      event_id: exact.toString(),
      delivery_id: id,
    });
  });
  it("records permanent refusal and clears an earlier error on success", async () => {
    const subscription = await hook();
    await note();
    const refused = new WebhookScheduler({
      storage: ctx.storage,
      http: {
        post: () =>
          Promise.resolve({
            kind: "answered",
            status: 400,
            retryAfter: null,
          } as const),
      },
    });
    await refused.runOnce();
    const page = await ctx.storage.outboundWebhookDeliveries.list(
      subscription.id,
      { limit: 10 },
    );
    expect(page.data[0]).toMatchObject({
      status: "dead_letter",
      status_code: 400,
      attempt: 1,
      error: "HTTP 400",
      succeeded: false,
    });
    const id = await ctx.storage.outboundWebhookDeliveries.schedule({
      webhookId: subscription.id,
      eventId: 1n,
      eventType: "item.created",
      payload: "{}",
      webhookUrl: "https://receiver.example/hook",
      nextAttemptAt: new Date().toISOString(),
    });
    await ctx.storage.outboundWebhookDeliveries.markFailed(
      id,
      503,
      "HTTP 503",
      1,
      new Date().toISOString(),
    );
    await ctx.storage.outboundWebhookDeliveries.markSuccess(id, 200, 2);
    expect(
      (
        await ctx.storage.outboundWebhookDeliveries.list(subscription.id, {
          limit: 10,
        })
      ).data.find((row) => row.id === id),
    ).toMatchObject({
      status: "success",
      status_code: 200,
      attempt: 2,
      error: null,
      succeeded: true,
    });
  });
  it("reports cancellation before HTTP without inventing an attempt", async () => {
    const subscription = await hook();
    await note();
    await scheduler.runOnce();
    expect(sent).toHaveLength(1);
    await note();
    const [event] = await ctx.storage.eventLog.getAfter(1n, 1);
    if (!event) throw new Error("ordinary event missing");
    const id = await ctx.storage.outboundWebhookDeliveries.schedule({
      webhookId: subscription.id,
      eventId: event.id,
      eventType: "item.created",
      payload: event.payload,
      webhookUrl: "https://receiver.example/hook",
      nextAttemptAt: new Date().toISOString(),
    });
    expect(
      (await api("PATCH", `/webhooks/${subscription.id}`, { active: false }))
        .status,
    ).toBe(200);
    const page = await ctx.storage.outboundWebhookDeliveries.list(
      subscription.id,
      { limit: 10 },
    );
    expect(page.data.find((row) => row.id === id)).toMatchObject({
      status: "canceled",
      succeeded: false,
      attempt: 0,
      status_code: null,
    });
    await scheduler.runOnce();
    expect(sent).toHaveLength(1);
  });
  it("normalizes blanks and refuses malformed single filters without changing the subscription", async () => {
    const subscription = await hook(["item.created"], " core.note ");
    expect(
      (await ctx.storage.outboundWebhooks.get(subscription.id))?.type_filter,
    ).toBe("core.note");
    for (const filter of ["*", "bad filter", "core.note,core.task"]) {
      expect(
        (
          await api("POST", "/webhooks", {
            url: "https://receiver.example/hook",
            events: ["item.created"],
            type_filter: filter,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await api("PATCH", `/webhooks/${subscription.id}`, {
            type_filter: filter,
          })
        ).status,
      ).toBe(400);
      expect(
        (await ctx.storage.outboundWebhooks.get(subscription.id))?.type_filter,
      ).toBe("core.note");
    }
    const invalid = await api("PATCH", `/webhooks/${subscription.id}`, {
      type_filter: "*",
    });
    expect(invalid.data).toMatchObject({
      error: {
        code: "validation_error",
        details: { errors: [{ path: "type_filter" }] },
      },
    });
    for (const filter of ["core.*", "demo.unknown"]) {
      expect(
        (
          await api("PATCH", `/webhooks/${subscription.id}`, {
            type_filter: filter,
          })
        ).status,
      ).toBe(200);
    }
    for (const filter of ["", " ", null]) {
      expect(
        (
          await api("PATCH", `/webhooks/${subscription.id}`, {
            type_filter: filter,
          })
        ).status,
      ).toBe(200);
      expect(
        (await ctx.storage.outboundWebhooks.get(subscription.id))?.type_filter,
      ).toBeUndefined();
    }
  });
  it("matches declared subtypes with a positive unfiltered receiver", async () => {
    expect(
      (
        await api("POST", "/types", {
          id: "demo.declared_note",
          label: "Declared note",
          parent: "core.note",
          version: 1,
          fields: {},
        })
      ).status,
    ).toBe(201);
    await hook();
    await hook(["item.created"], "core.note");
    await note("demo.declared_note");
    await scheduler.runOnce();
    expect(sent).toHaveLength(2);
  });
  it("matches dotted children with a positive unfiltered receiver", async () => {
    for (const id of ["demo.root", "demo.root.child"])
      expect(
        (
          await api("POST", "/types", {
            id,
            label: "Namespace note",
            version: 1,
            fields: { body: { type: "string" } },
          })
        ).status,
      ).toBe(201);
    await hook();
    await hook(["item.created"], "demo.root");
    await note("demo.root.child");
    await scheduler.runOnce();
    expect(sent).toHaveLength(2);
  });
  it("delivers independently reachable edges under an item filter", async () => {
    await hook(["edge.created"]);
    await hook(["edge.created"], "core.task");
    const narrow = await mintWorkingKey(ctx, {
      type_permissions: { "core.task": "read" },
      edge_permissions: { references: "read" },
    });
    const denied = await request(ctx.app, "POST", "/webhooks", {
      key: narrow,
      body: {
        url: "https://receiver.example/hook",
        events: ["edge.created"],
        type_filter: "core.task",
      },
    });
    expect(denied.status).toBe(201);
    const deniedId = ((await denied.json()) as { id: string }).id;
    const source = await note();
    const target = await note();
    expect(
      (
        await api("POST", "/edges", {
          edge_type: "references",
          source_id: source.id,
          target_id: target.id,
          properties: {},
        })
      ).status,
    ).toBe(201);
    await scheduler.runOnce();
    expect(sent).toHaveLength(2);
    expect(
      (
        await ctx.storage.outboundWebhookDeliveries.list(deniedId, {
          limit: 10,
        })
      ).data,
    ).toHaveLength(0);
    expect(sent.every((frame) => frame.event_type === "edge.created")).toBe(
      true,
    );
  });
});
