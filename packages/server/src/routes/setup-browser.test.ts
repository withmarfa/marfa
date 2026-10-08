import { afterAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createClaimTestApp } from "../auth/claim-test-app.js";
import { launchTestBrowser, reserveOrigin } from "../test-browser.js";
import {
  getClaimStatus,
  issueSetupCode,
  issueSetupTicket,
} from "../auth/instance-claim.js";
import { authStaticRoutes } from "./auth-static.js";

const launched = await launchTestBrowser();
if (launched instanceof Error && process.env.CI) throw launched;
const browser = launched instanceof Error ? null : launched;
afterAll(async () => {
  await browser?.close();
});
const inBrowser = browser ? describe : describe.skip;
inBrowser("setup in a real browser", () => {
  it("removes handoff fragments, exchanges once, survives refresh and back, and claims", async () => {
    if (!browser) throw new Error("Browser unavailable");
    const reserved = await reserveOrigin(),
      ctx = await createClaimTestApp(reserved.origin);
    ctx.app.route("/auth/static", authStaticRoutes());
    ctx.app.get("/elsewhere", (c) => c.text("Another page"));
    const server = serve({
      fetch: ctx.app.fetch,
      hostname: "127.0.0.1",
      port: reserved.port,
    }) as Server;
    const context = await browser.newContext(),
      page = await context.newPage();
    const refusals: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy"))
        refusals.push(message.text());
    });
    try {
      await issueSetupCode(ctx.storage);
      const { ticket } = await issueSetupTicket(ctx.storage);
      let exchanges = 0;
      page.on("request", (request) => {
        if (request.url().endsWith("/setup/exchange")) exchanges++;
      });
      await page.goto(`${reserved.origin}/setup#handoff=${ticket}`);
      await page.waitForSelector("#owner-form:not([hidden])");
      expect(page.url()).toBe(`${reserved.origin}/setup`);
      expect(exchanges).toBe(1);
      expect(
        await page.evaluate(() => ({
          local: localStorage.length,
          session: sessionStorage.length,
        })),
      ).toEqual({ local: 0, session: 0 });
      await page.reload();
      await page.waitForSelector("#owner-form:not([hidden])");
      expect(exchanges).toBe(1);
      await page.goto(`${reserved.origin}/elsewhere`);
      await page.goBack({ waitUntil: "commit" });
      await page.waitForSelector("#owner-form:not([hidden])");
      expect(exchanges).toBe(1);
      await page.fill("#email", "owner@example.com");
      await page.fill("#password", "correct horse battery");
      await page.click("#owner-form button");
      await page.waitForURL(/\/auth\/sign-in$/);
      expect((await getClaimStatus(ctx.storage)).claimed).toBe(true);
      expect(refusals).toEqual([]);
    } finally {
      await context.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
      await ctx.cleanup();
    }
  });
  it("enters a grouped code without a handoff", async () => {
    if (!browser) throw new Error("Browser unavailable");
    const reserved = await reserveOrigin(),
      ctx = await createClaimTestApp(reserved.origin);
    ctx.app.route("/auth/static", authStaticRoutes());
    const server = serve({
      fetch: ctx.app.fetch,
      hostname: "127.0.0.1",
      port: reserved.port,
    }) as Server;
    const context = await browser.newContext(),
      page = await context.newPage();
    try {
      const { code } = await issueSetupCode(ctx.storage);
      await page.goto(`${reserved.origin}/setup`);
      await page.fill("#code", code.toLowerCase());
      await page.click("#code-form button");
      await page.waitForSelector("#owner-form:not([hidden])");
      expect(await page.inputValue("#code")).toBe("");
      await page.fill("#email", "owner@example.com");
      await page.fill("#password", "correct horse battery");
      await page.click("#owner-form button");
      await page.waitForURL(/\/auth\/sign-in$/);
      expect((await getClaimStatus(ctx.storage)).claimed).toBe(true);
    } finally {
      await context.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
      await ctx.cleanup();
    }
  });
});
