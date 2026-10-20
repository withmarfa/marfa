/**
 * The General page in a real browser against a real listener under the real
 * policy: a change shows the save bar, Save sends only what changed, and the
 * page then shows it saved.
 */
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  launchTestBrowser,
  listen,
  reserveOrigin,
} from "../../test-browser.js";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { readInstanceConfig } from "../../storage/instance-config.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const inBrowser = launched instanceof Error ? it.skip : it;

let browser: Browser;
let origin: string;
let ctx: TestContext;
let server: { close: () => Promise<void> };

beforeAll(async () => {
  if (launched instanceof Error) return;
  browser = launched;
  const reserved = await reserveOrigin();
  origin = reserved.origin.replace("127.0.0.1", "localhost");
  ctx = await createTestContext({
    authBaseUrl: origin,
    trustedProxyHeader: "x-real-ip",
  });
  server = listen(ctx.app, reserved.port);
});

afterAll(async () => {
  if (launched instanceof Error) return;
  await browser.close();
  await server.close();
  await ctx.cleanup();
});

describe("General", () => {
  inBrowser(
    "shows the save bar for a change, saves only that change, and refuses an empty name",
    async () => {
      const context = await browser.newContext({
        extraHTTPHeaders: { "x-real-ip": "198.51.100.77" },
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
        const page = await context.newPage();
        const sent: string[] = [];
        page.on("request", (request) => {
          if (request.method() === "PATCH") sent.push(request.postData() ?? "");
        });
        await page.goto(`${origin}/auth/owner/general`);
        const bar = page.locator("[data-save-bar]");
        const save = page.getByRole("button", { name: "Save", exact: true });
        const name = page.locator("#general-name");
        await name.waitFor();
        expect(await bar.isVisible()).toBe(false);

        // Nothing is sent for an empty name.
        await name.fill("");
        await save.click();
        await page.getByText("Give this Marfa a name.").waitFor();
        expect(sent).toEqual([]);

        await name.fill("Study Marfa");
        await page
          .locator("select[name=trash_retention_days]")
          .selectOption("365");
        await save.click();
        await page.getByText("Saved").waitFor();
        expect(sent.map((body) => JSON.parse(body) as unknown)).toEqual([
          { name: "Study Marfa", trash_retention_days: 365 },
        ]);
        const stored = await readInstanceConfig(ctx.storage.settings);
        expect(stored).toMatchObject({
          name: "Study Marfa",
          trash_retention_days: 365,
        });
        expect(await name.inputValue()).toBe("Study Marfa");
        expect(await bar.isVisible()).toBe(false);
      } finally {
        await context.close();
      }
    },
  );
});
