import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBusyBudgetMs } from "../storage/sqlite/connection.js";
import { createTestContext, type TestContext } from "../test-utils.js";
import { settleRateLimits } from "./rate-limit.js";

// GET /items is judged against twice the default.
const DEFAULT_LIMIT = 3;
const GET_LIMIT = DEFAULT_LIMIT * 2;
const BUDGET_MS = 100;

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext({
    rateLimitEnabled: true,
    rateLimitDefaultLimit: DEFAULT_LIMIT,
    rateLimitWindowMs: 60_000,
    rateLimitAggregateMultiplier: 0,
  });
  setBusyBudgetMs(BUDGET_MS);
});

afterEach(async () => {
  setBusyBudgetMs(5_000);
  await ctx.cleanup();
});

/** Opens a write transaction, as a bulk page does, and keeps it open. */
async function holdTheWriter(): Promise<{ release: () => Promise<void> }> {
  let begun!: () => void;
  let end!: () => void;
  const opened = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const held = ctx.storage.runInTransaction(
    () =>
      new Promise<void>((resolve) => {
        end = resolve;
        begun();
      }),
  );
  await opened;
  return {
    release: async () => {
      end();
      await held;
    },
  };
}

async function workingKeyId(): Promise<string> {
  const keys = await ctx.storage.keys.list();
  const res = await ctx.app.request("/items?limit=1", {
    headers: { Authorization: `Bearer ${ctx.workingKey}` },
  });
  expect(res.status).toBe(200);
  // The key whose use the request just recorded is the working key.
  for (const key of keys) {
    const window = await ctx.storage.rateLimits.peekWindow(
      "rate",
      `${key.id}:/items`,
      new Date().toISOString(),
    );
    if (window) return key.id;
  }
  throw new Error("no rate-limit window was written for the working key");
}

function list() {
  return ctx.app.request("/items?limit=1", {
    headers: { Authorization: `Bearer ${ctx.workingKey}` },
  });
}

describe("the rate limiter while a write transaction holds the lock", () => {
  it("answers a read instead of waiting for the lock, and still holds the cap", async () => {
    const keyId = await workingKeyId();
    const writer = await holdTheWriter();
    try {
      // One request is already counted, so the cap leaves this many.
      for (let i = 2; i <= GET_LIMIT; i++) {
        const res = await list();
        expect(res.status).toBe(200);
        expect(res.headers.get("X-RateLimit-Remaining")).toBe(
          String(GET_LIMIT - i),
        );
      }
      expect((await list()).status).toBe(429);
    } finally {
      await writer.release();
    }

    await settleRateLimits(ctx.storage);
    const stored = await ctx.storage.rateLimits.peekWindow(
      "rate",
      `${keyId}:/items`,
      new Date().toISOString(),
    );
    // Every request counted while the lock was held reached the shared
    // window once it was free.
    expect(stored?.count).toBe(GET_LIMIT + 1);
  });

  it("writes the window directly when nothing holds the lock", async () => {
    const keyId = await workingKeyId();
    expect((await list()).status).toBe(200);
    // Nothing is owed, so the count is already the shared one.
    const stored = await ctx.storage.rateLimits.peekWindow(
      "rate",
      `${keyId}:/items`,
      new Date().toISOString(),
    );
    expect(stored?.count).toBe(2);
  });
});
