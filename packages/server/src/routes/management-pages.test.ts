import { afterAll, describe, expect, it } from "vitest";
import { createTestContext } from "../test-utils.js";
import { launchTestBrowser, listen, reserveOrigin } from "../test-browser.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const browser = launched instanceof Error ? null : launched;
afterAll(async () => {
  await browser?.close();
});
const inBrowser = browser ? describe : describe.skip;

inBrowser("trusted management pages", () => {
  it("makes and revokes a key on the API keys pages through the documented operations without browser storage", async () => {
    if (!browser) throw new Error("Browser unavailable");
    const { origin, port } = await reserveOrigin();
    const ctx = await createTestContext({ authBaseUrl: origin });
    const server = listen(ctx.app, port);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const signedIn = await context.request.post(
        `${origin}/auth/sign-in/email`,
        {
          headers: { origin },
          data: { email: ctx.owner.email, password: ctx.owner.password },
        },
      );
      expect(signedIn.status()).toBe(200);
      await page.goto(`${origin}/auth/owner/manage`);
      await page.locator("#health").filter({ hasText: "Status:" }).waitFor();
      expect(await page.textContent("#status")).toBe("");
      await page.getByRole("link", { name: "API keys" }).click();
      await page.waitForURL(`${origin}/auth/owner/keys`);
      await page.getByRole("link", { name: "Create key" }).click();
      await page.getByLabel("Name").fill("Browser manager");
      await page.getByLabel("Source it writes as").fill("browser-manager");
      await page
        .locator("summary", { hasText: "More control over Marfa" })
        .click();
      await page.locator('input[value="instance.read"]').check();
      await page.getByRole("button", { name: "Create key" }).click();
      const secret = page.locator("#key-secret");
      await secret.filter({ hasText: "marfa_k1_" }).waitFor();
      const shown = (await secret.textContent()) ?? "";
      const listed = await ctx.ownerRequest("/keys");
      const key = (
        (await listed.json()) as {
          data: {
            id: string;
            source: string;
            permissions: string[];
            type_permissions: Record<string, string>;
          }[];
        }
      ).data.find(
        (row: { source: string }) => row.source === "browser-manager",
      );
      expect(key!.permissions).toEqual(["instance.read"]);
      expect(key!.type_permissions).toEqual({});
      // The secret is on the screen and nowhere that outlasts it.
      expect(page.url()).toBe(`${origin}/auth/owner/keys/${key!.id}/copy`);
      expect(page.url()).not.toContain(shown);
      expect(
        await page.evaluate(() => [localStorage.length, sessionStorage.length]),
      ).toEqual([0, 0]);
      await page.getByRole("link", { name: "Done" }).click();
      await page.waitForURL(`${origin}/auth/owner/keys/${key!.id}`);
      await page.getByRole("button", { name: "Revoke" }).click();
      await page
        .getByRole("dialog", { name: "Revoke Browser manager?" })
        .getByRole("button", { name: "Revoke" })
        .click();
      await page.waitForURL(`${origin}/auth/owner/keys`);
      await page.getByText("Revoked Browser manager").waitFor();
      expect(await ctx.storage.keys.get(key!.id)).toBeNull();
      // The word was kept for one page and is gone with it.
      expect(
        await page.evaluate(() => [localStorage.length, sessionStorage.length]),
      ).toEqual([0, 0]);
      await page.goto(`${origin}/auth/owner/restore`);
      expect(await page.locator("#archive").count()).toBe(1);
      expect(
        await page.getByRole("link", { name: "Sign in again" }).count(),
      ).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await server.close();
      await ctx.housekeeping.stop();
      await ctx.cleanup();
    }
  });
  it("shows the maintenance error when a completed HTTP request reports a failed run", async () => {
    if (!browser) throw new Error("Browser unavailable");
    const { origin, port } = await reserveOrigin();
    const ctx = await createTestContext({ authBaseUrl: origin });
    let shouldFail = false;
    ctx.housekeeping.register({
      name: "browser-maintenance",
      intervalMs: 3_600_000,
      firstRunDelayMs: 3_600_000,
      run: () =>
        shouldFail
          ? Promise.reject(new Error("The maintenance sweep could not finish."))
          : Promise.resolve({ checked: 1 }),
    });
    await ctx.housekeeping.start();
    const server = listen(ctx.app, port);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });
    try {
      const signedIn = await context.request.post(
        `${origin}/auth/sign-in/email`,
        {
          headers: { origin },
          data: { email: ctx.owner.email, password: ctx.owner.password },
        },
      );
      expect(signedIn.status()).toBe(200);
      await page.goto(`${origin}/auth/owner/manage`);
      const button = page
        .locator("#jobs li")
        .filter({ hasText: "browser-maintenance" })
        .getByRole("button", { name: "Run maintenance" });
      await button.click();
      await expect.poll(() => page.textContent("#status")).toBe("Done.");
      shouldFail = true;
      const response = page.waitForResponse((res) =>
        res.url().endsWith("/housekeeping/browser-maintenance/run"),
      );
      await button.click();
      const failedRun = await response;
      expect(failedRun.status()).toBe(200);
      expect(await failedRun.json()).toMatchObject({
        outcome: "error",
        error: "The maintenance sweep could not finish.",
      });
      await expect
        .poll(() => page.textContent("#status"))
        .toBe("The maintenance sweep could not finish.");
      expect(await button.isEnabled()).toBe(true);
    } finally {
      await context.close();
      await server.close();
      await ctx.housekeeping.stop();
      await ctx.cleanup();
    }
  });
});
