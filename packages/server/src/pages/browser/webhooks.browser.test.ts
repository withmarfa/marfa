import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Browser } from "playwright-core";
import {
  launchTestBrowser,
  listen,
  reserveOrigin,
} from "../../test-browser.js";
import {
  createTestContext,
  request,
  type TestContext,
} from "../../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../../pubsub.js";
import { WebhookPoller, WebhookScheduler } from "../../webhooks/delivery.js";
const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;
let browser: Browser;
let ctx: TestContext;
let server: { close: () => Promise<void> };
let origin: string;
let id: string;
let keyId: string;
beforeAll(async () => {
  if (launched instanceof Error) return;
  browser = launched;
  const reserved = await reserveOrigin();
  origin = reserved.origin.replace("127.0.0.1", "localhost");
  ctx = await createTestContext({ authBaseUrl: origin });
  server = listen(ctx.app, reserved.port);
  initEventLog(ctx.storage.eventLog);
  const hook = await request(ctx.app, "POST", "/webhooks", {
    key: ctx.workingKey,
    body: { url: "https://receiver.example/hook", events: ["item.created"] },
  });
  id = ((await hook.json()) as { id: string }).id;
  const owner = (await ctx.storage.outboundWebhooks.get(id))!.owner;
  if (owner.kind !== "key") throw new Error("fixture");
  keyId = owner.keyId;
  await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "private-frame" } },
  });
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
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (launched instanceof Error) return;
  __resetEventLogForTests();
  await browser.close();
  await server.close();
  await ctx.cleanup();
});
inBrowser(
  "keeps unsaved key changes and retry usable after cancelled confirmation, then queues once",
  async () => {
    const context = await browser.newContext();
    try {
      const login = await context.request.post(origin + "/auth/sign-in/email", {
        headers: { origin },
        data: { email: ctx.owner.email, password: ctx.owner.password },
      });
      expect(login.status()).toBe(200);
      const page = await context.newPage();
      await page.goto(`${origin}/auth/owner/keys/${keyId}`);
      expect(await page.content()).not.toContain("private-frame");
      await page.getByLabel("Ends", { exact: true }).selectOption("30");
      await page.getByText("Delivery history", { exact: true }).click();
      await (
        ctx.storage as typeof ctx.storage & {
          __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
        }
      ).__sqliteRun(
        "UPDATE auth_session SET created_at = created_at - 360",
        [],
      );
      const retry = page.locator('[data-hook="webhook-retry"]');
      await retry.click();
      const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
      await confirm.waitFor();
      await confirm
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await confirm.waitFor({ state: "hidden" });
      expect(await retry.isEnabled()).toBe(true);
      expect(
        await page
          .getByRole("button", { name: "Save", exact: true })
          .isEnabled(),
      ).toBe(true);
      await retry.click();
      await confirm.waitFor();
      await confirm.getByLabel("Or your password").fill(ctx.owner.password);
      await confirm.getByRole("button", { name: "Continue" }).click();
      await page
        .getByText("Retry queued. Reload the page later to see the result.", {
          exact: true,
        })
        .waitFor();
      expect(await retry.isHidden()).toBe(true);
      expect(await page.getByLabel("Ends", { exact: true }).inputValue()).toBe(
        "30",
      );
      expect(
        await page
          .getByRole("button", { name: "Save", exact: true })
          .isEnabled(),
      ).toBe(true);
    } finally {
      await context.close();
    }
  },
);
inBrowser(
  "reports a failed history read without claiming no deliveries",
  async () => {
    const failure = vi
      .spyOn(ctx.storage.outboundWebhookDeliveries, "list")
      .mockRejectedValueOnce(new Error("read failed"));
    const response = await ctx.ownerRequest(`/auth/owner/keys/${keyId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Delivery history could not be loaded");
    expect(html).not.toContain("No deliveries");
    failure.mockRestore();
  },
);

inBrowser(
  "loads the full last page and keeps a failed page read retryable",
  async () => {
    for (let i = 0; i < 11; i++)
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: `more ${String(i)}` } },
      });
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
    const context = await browser.newContext();
    try {
      expect(
        (
          await context.request.post(origin + "/auth/sign-in/email", {
            headers: { origin },
            data: { email: ctx.owner.email, password: ctx.owner.password },
          })
        ).status(),
      ).toBe(200);
      const page = await context.newPage();
      await page.goto(`${origin}/auth/owner/keys/${keyId}`);
      await page.getByText("Delivery history", { exact: true }).click();
      expect(await page.locator("[data-delivery-row]").count()).toBe(10);
      await page.route(
        `**/webhooks/${id}/deliveries?*`,
        async (route) => {
          await route.fulfill({ status: 500, body: "{}" });
        },
        { times: 1 },
      );
      const more = page.locator('[data-hook="webhook-more"]');
      await more.click();
      await page
        .getByText("More deliveries could not be loaded. Try again.", {
          exact: true,
        })
        .waitFor();
      expect(await page.locator("[data-delivery-row]").count()).toBe(10);
      expect(await more.isEnabled()).toBe(true);
      await more.click();
      await more.waitFor({ state: "hidden" });
      expect(await page.locator("[data-delivery-row]").count()).toBe(12);
    } finally {
      await context.close();
    }
  },
);
