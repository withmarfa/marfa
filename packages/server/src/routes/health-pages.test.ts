import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pageButtons, visibleText } from "../pages/reading.js";
import { createTestContext, cleanupTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let sweepBroken = false;

beforeAll(async () => {
  ctx = await createTestContext({});
  ctx.housekeeping.register({
    name: "audit-cleanup",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => Promise.resolve(null),
  });
  ctx.housekeeping.register({
    name: "webhook-poll",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () =>
      sweepBroken
        ? Promise.reject(new Error("the sweep broke"))
        : Promise.resolve(null),
  });
  await ctx.housekeeping.start();
  await ctx.housekeeping.runNow("audit-cleanup");
});

afterAll(async () => {
  await ctx.housekeeping.stop();
  await cleanupTestContext(ctx);
});

async function html(path: string): Promise<string> {
  const res = await ctx.ownerRequest(path, {
    headers: { accept: "text/html" },
  });
  expect(res.status).toBe(200);
  return res.text();
}

describe("the Health page", () => {
  it("says Marfa is working, lists each job with a Run now button, and keeps Home quiet", async () => {
    const page = await html("/auth/owner/health");
    const text = visibleText(page);
    expect(text).toContain("Database");
    expect(text).toContain("Working");
    expect(text).toContain("Audit cleanup");
    expect(text).toContain("Webhook poll");
    expect(
      pageButtons(page).filter((button) => button.text === "Run now"),
    ).toHaveLength(2);
    expect(visibleText(await html("/"))).not.toContain("Webhook poll failed");
  });

  it("puts a failed job first with its error, and Home lists it as needing attention", async () => {
    sweepBroken = true;
    await ctx.housekeeping.runNow("webhook-poll");
    const text = visibleText(await html("/auth/owner/health"));
    expect(text).toContain("the sweep broke");
    // Webhook poll sorts after Audit cleanup by name, so it leads only for failing.
    expect(text.indexOf("Webhook poll")).toBeLessThan(
      text.indexOf("Audit cleanup"),
    );
    const home = visibleText(await html("/"));
    expect(home).toContain("Webhook poll failed");
    expect(home).toContain("Needs a look");
  });
});

it.each(["failure", "timeout"])(
  "shows unavailable jobs on the Health page after %s",
  async (mode) => {
    const jobs = vi
      .spyOn(ctx.housekeeping, "list")
      .mockImplementation(() =>
        mode === "failure"
          ? Promise.reject(new Error("unavailable"))
          : new Promise(() => undefined),
      );
    try {
      const text = visibleText(await html("/auth/owner/health"));
      expect(text).toContain("Couldn't read the jobs");
      expect(text).toContain("Database");
    } finally {
      jobs.mockRestore();
    }
  },
);
