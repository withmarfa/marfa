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
  it("creates and revokes a key through the documented operations without browser storage", async () => {
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
      await page.locator("summary").click();
      await page.fill("#label", "Browser manager");
      await page.fill("#source", "browser-manager");
      await page.check('input[value="instance.read"]');
      await page.click("#mint button");
      await page.locator("#new-key").filter({ hasText: "marfa_k1_" }).waitFor();
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
      page.once("dialog", (dialog) => {
        void dialog.accept();
      });
      await page
        .locator("#keys li")
        .filter({ hasText: "Browser manager" })
        .getByRole("button", { name: "Revoke" })
        .click();
      await page
        .locator("#keys li")
        .filter({ hasText: "Browser manager" })
        .waitFor({ state: "detached" });
      expect(await ctx.storage.keys.get(key!.id)).toBeNull();
      expect(
        await page.evaluate(() => [localStorage.length, sessionStorage.length]),
      ).toEqual([0, 0]);
      await page.goto(`${origin}/auth/owner/restore`);
      expect(await page.locator("#archive").count()).toBe(1);
      await page.getByRole("link", { name: "Sign in again" }).click();
      expect(await page.locator('input[type="password"]').count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await server.close();
      await ctx.cleanup();
    }
  });
});
