import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { withRequestAuthority } from "../auth/request-authority.js";
import { createTestContext, type TestContext } from "../test-utils.js";
import { Housekeeping } from "./scheduler.js";
import { WebhookPoller } from "../webhooks/delivery.js";
import { createWebhookHttpClient } from "../webhooks/outbound-http.js";

let ctx: TestContext | undefined;
let scheduler: Housekeeping | undefined;
afterEach(async () => {
  await scheduler?.stop();
  await ctx?.cleanup();
  vi.restoreAllMocks();
});

it("polls webhook deliveries without inheriting the manual run's context", async () => {
  ctx = await createTestContext();
  scheduler = new Housekeeping(ctx.storage.housekeeping, {
    pollIntervalMs: 60_000,
  });
  const request = new AsyncLocalStorage<string>();
  const contexts: (string | undefined)[] = [];
  const read = ctx.storage.outboundWebhookDeliveries.getPending.bind(
    ctx.storage.outboundWebhookDeliveries,
  );
  vi.spyOn(
    ctx.storage.outboundWebhookDeliveries,
    "getPending",
  ).mockImplementation((...args) => {
    contexts.push(request.getStore());
    return read(...args);
  });
  const poller = new WebhookPoller({
    storage: ctx.storage,
    http: createWebhookHttpClient({ allowPrivateAddresses: false }),
  });
  scheduler.register({
    name: "webhook-poll",
    intervalMs: 60_000,
    firstRunDelayMs: 60_000,
    run: () => poller.runOnce(),
  });
  await scheduler.start();
  const result = await request.run("request", () => {
    expect(request.getStore()).toBe("request");
    return scheduler!.runNow("webhook-poll");
  });
  expect(result).toMatchObject({ kind: "ran", run: { outcome: "ok" } });
  expect(contexts).toEqual([undefined]);
});

it("authorizes the claim but runs and records the job independently of the caller", async () => {
  ctx = await createTestContext();
  scheduler = new Housekeeping(ctx.storage.housekeeping, {
    pollIntervalMs: 60_000,
  });
  let revoked = false;
  let validations = 0;
  scheduler.register({
    name: "probe",
    intervalMs: 60_000,
    firstRunDelayMs: 60_000,
    run: async () => {
      revoked = true;
      await ctx!.storage.runInTransaction(() => Promise.resolve());
      return { written: true };
    },
  });
  await scheduler.start();
  const validate = () => {
    validations += 1;
    return revoked
      ? Promise.reject(new Error("revoked credential"))
      : Promise.resolve();
  };
  const result = await withRequestAuthority(validate, () =>
    scheduler!.runNow("probe"),
  );
  expect(validations).toBeGreaterThan(0);
  expect(result).toMatchObject({
    kind: "ran",
    run: { outcome: "ok", result: { written: true } },
  });
  expect(await ctx.storage.housekeeping.get("probe")).toMatchObject({
    running_since: null,
    last_outcome: "ok",
  });
  await expect(
    withRequestAuthority(validate, () => scheduler!.runNow("probe")),
  ).rejects.toThrow("revoked credential");
});
