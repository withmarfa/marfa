import { afterAll, beforeAll, expect, it } from "vitest";
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
const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;
let browser: Browser;
let ctx: TestContext;
let origin: string;
let server: { close: () => Promise<void> };
beforeAll(async () => {
  if (launched instanceof Error) return;
  browser = launched;
  const reserved = await reserveOrigin();
  origin = reserved.origin.replace("127.0.0.1", "localhost");
  ctx = await createTestContext({ authBaseUrl: origin });
  server = listen(ctx.app, reserved.port);
  const made = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { title: "Trash witness", body: "Private" },
    },
  });
  const id = ((await made.json()) as { item: { id: string } }).item.id;
  expect(
    (
      await ctx.ownerRequest(`/items/summaries/${id}/trash?version=1`, {
        method: "POST",
      })
    ).status,
  ).toBe(200);
});
afterAll(async () => {
  if (launched instanceof Error) return;
  await browser.close();
  await server.close();
  await ctx.cleanup();
});
inBrowser(
  "stops an uncertain batch without following a continuation or reporting the item kept",
  async () => {
    const context = await browser.newContext();
    try {
      expect(
        (
          await context.request.post(`${origin}/auth/sign-in/email`, {
            headers: { origin },
            data: { email: ctx.owner.email, password: ctx.owner.password },
          })
        ).status(),
      ).toBe(200);
      const page = await context.newPage();
      let attempts = 0;
      await page.route("**/trash/empty*", async (route) => {
        attempts++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            purged: 1,
            failures: [
              {
                id: "uncertain",
                code: "internal_error",
                message: "Unknown",
                details: { write_outcome: "unknown" },
              },
            ],
            next_cursor: "must-not-follow",
          }),
        });
      });
      await page.goto(`${origin}/auth/owner/trash`);
      await page
        .getByRole("button", { name: "Empty trash", exact: true })
        .first()
        .click();
      await page
        .locator('dialog[open] button[data-item-change="empty"]')
        .click();
      await page
        .getByText("Another deletion could not be confirmed.", { exact: false })
        .waitFor();
      expect(attempts).toBe(1);
      expect(
        await page
          .locator("dialog[open] [data-item-problem-text]")
          .textContent(),
      ).toContain("Refresh the page before trying again.");
      expect(
        await page
          .locator("dialog[open] [data-item-problem-text]")
          .textContent(),
      ).toContain("0 could not be deleted");
    } finally {
      await context.close();
    }
  },
);
