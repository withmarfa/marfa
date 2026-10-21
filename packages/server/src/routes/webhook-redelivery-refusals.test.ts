import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { WebhookPoller, WebhookScheduler } from "../webhooks/delivery.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

async function sql(statement: string, args: unknown[]): Promise<void> {
  await (
    ctx.storage as typeof ctx.storage & {
      __sqliteRun(statement: string, args: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(statement, args);
}

let maker = "";

/** A webhook made by a key of its own, with one delivery the receiver refused for good. */
async function failedDelivery() {
  maker = await mintWorkingKey(ctx);
  const current = await request(ctx.app, "GET", "/keys/current", {
    key: maker,
  });
  const keyId = ((await current.json()) as { id: string }).id;
  const created = await request(ctx.app, "POST", "/webhooks", {
    key: maker,
    body: { url: "https://receiver.example/hook", events: ["item.created"] },
  });
  expect(created.status).toBe(201);
  const webhookId = ((await created.json()) as { id: string }).id;
  const note = await request(ctx.app, "POST", "/items", {
    key: maker,
    body: { type: "core.note", properties: { body: "sent" } },
  });
  expect(note.status).toBe(201);
  await new WebhookScheduler({
    storage: ctx.storage,
    wakePoller: () => Promise.resolve(),
  }).runOnce();
  await new WebhookPoller({
    storage: ctx.storage,
    http: {
      post: () =>
        Promise.resolve({ kind: "answered", status: 400, retryAfter: null }),
    },
  }).runOnce();
  const delivery = (
    await ctx.storage.outboundWebhookDeliveries.list(webhookId, { limit: 10 })
  ).data[0]!;
  expect(delivery.status).toBe("dead_letter");
  return { keyId, webhookId, deliveryId: delivery.id };
}

async function redeliver(webhookId: string, deliveryId: string) {
  const answer = await ctx.ownerRequest(
    `/webhooks/${webhookId}/deliveries/${deliveryId}/redeliver`,
    { method: "POST" },
  );
  return {
    status: answer.status,
    body: (await answer.json()) as {
      error?: { code: string; message: string; details?: unknown };
    },
  };
}

it("accepts the redelivery of a failed delivery, so each refusal below has a witness", async () => {
  const { webhookId, deliveryId } = await failedDelivery();
  expect((await redeliver(webhookId, deliveryId)).status).toBe(202);
});

it("names a turned-off webhook as the reason", async () => {
  const { webhookId, deliveryId } = await failedDelivery();
  const paused = await request(ctx.app, "PATCH", `/webhooks/${webhookId}`, {
    key: maker,
    body: { active: false },
  });
  expect(paused.status).toBe(200);
  const refused = await redeliver(webhookId, deliveryId);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatchObject({
    code: "conflict",
    details: { reason: "webhook_inactive" },
  });
  expect(refused.body.error?.message).toMatch(/turned off/);
});

it("names a maker that no longer holds webhooks.manage as the reason", async () => {
  const { keyId, webhookId, deliveryId } = await failedDelivery();
  const narrowed = await ctx.ownerRequest(`/keys/${keyId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permissions: [] }),
  });
  expect(narrowed.status).toBe(200);
  const refused = await redeliver(webhookId, deliveryId);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatchObject({
    code: "conflict",
    details: { reason: "credential_unavailable" },
  });
  expect(refused.body.error?.message).toMatch(/webhooks\.manage/);
});

it("names a delivery that has not failed for good as the reason", async () => {
  const { webhookId, deliveryId } = await failedDelivery();
  expect((await redeliver(webhookId, deliveryId)).status).toBe(202);
  const refused = await redeliver(webhookId, deliveryId);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatchObject({
    code: "conflict",
    details: { reason: "delivery_not_failed" },
  });
  expect(refused.body.error?.message).toMatch(/pending/);
});

it("names a delivery older than the audit retention as the reason", async () => {
  const { webhookId, deliveryId } = await failedDelivery();
  await sql(
    "UPDATE outbound_webhook_deliveries SET created_at = ? WHERE id = ?",
    ["2000-01-01T00:00:00.000Z", deliveryId],
  );
  const refused = await redeliver(webhookId, deliveryId);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatchObject({
    code: "conflict",
    details: { reason: "delivery_expired" },
  });
});

it("names an event the server no longer holds as the reason", async () => {
  const { webhookId, deliveryId } = await failedDelivery();
  await sql(
    "UPDATE outbound_webhook_deliveries SET payload = NULL WHERE id = ?",
    [deliveryId],
  );
  const refused = await redeliver(webhookId, deliveryId);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatchObject({
    code: "conflict",
    details: { reason: "delivery_not_retained" },
  });
});
