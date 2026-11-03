import { Hono } from "hono";
import { MarfaError } from "@withmarfa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRequestAuthority } from "../auth/request-authority.js";
import { advanceClock, nowMs, resetClockForTests } from "../clock.js";
import { setBusyBudgetMs } from "../storage/sqlite/connection.js";
import { createTestContext, type TestContext } from "../test-utils.js";
import type { AppEnv } from "./auth.js";
import { rateLimitMiddleware, settleRateLimits } from "./rate-limit.js";

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
  resetClockForTests();
  vi.restoreAllMocks();
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

/**
 * The limiter alone on a fresh ledger, as a process that has counted
 * nothing since it started: the full app's own requests would count first.
 * Each request runs inside a request's authority, as an authenticated one
 * does once `directAuthorityMiddleware` has run.
 */
const WINDOW_MS = 60_000;
const PROBE_KEY = "anon:/probe";

function limiterApp(validations: { count: number }) {
  const app = new Hono<AppEnv>();
  app.use("*", (_c, next) =>
    withRequestAuthority(() => {
      validations.count += 1;
      return Promise.resolve();
    }, next),
  );
  app.use(
    "*",
    rateLimitMiddleware({
      storage: ctx.storage,
      defaultLimit: DEFAULT_LIMIT,
      windowMs: WINDOW_MS,
      pathLimits: {},
      aggregateMultiplier: 0,
    }),
  );
  app.post("/probe", (c) => c.text("ok"));
  app.onError(
    (error) =>
      new Response(error.message, {
        status: error instanceof MarfaError ? error.status : 500,
      }),
  );
  return () => app.request("/probe", { method: "POST" });
}

async function plantCount(count: number): Promise<void> {
  const now = nowMs();
  await ctx.storage.rateLimits.incrementWindows(
    "rate",
    [PROBE_KEY],
    WINDOW_MS,
    new Date(now).toISOString(),
    new Map([
      [
        PROBE_KEY,
        { count, expires_at: new Date(now + WINDOW_MS).toISOString() },
      ],
    ]),
  );
}

async function sharedCount(): Promise<number | undefined> {
  return (
    await ctx.storage.rateLimits.peekWindow(
      "rate",
      PROBE_KEY,
      new Date(nowMs()).toISOString(),
    )
  )?.count;
}

describe("the limiter's count", () => {
  it("does not ask the request's authority again", async () => {
    const validations = { count: 0 };
    const probe = limiterApp(validations);
    expect((await probe()).status).toBe(200);
    const writer = await holdTheWriter();
    try {
      expect((await probe()).status).toBe(200);
    } finally {
      await writer.release();
    }
    await settleRateLimits(ctx.storage);
    expect(await sharedCount()).toBe(2);
    expect(validations.count).toBe(0);
  });

  it("holds the cap on the shared window when this process has counted nothing yet", async () => {
    const probe = limiterApp({ count: 0 });
    await plantCount(DEFAULT_LIMIT - 1);
    const writer = await holdTheWriter();
    try {
      const last = await probe();
      expect(last.status).toBe(200);
      expect(last.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect((await probe()).status).toBe(429);
    } finally {
      await writer.release();
    }
    await settleRateLimits(ctx.storage);
    expect(await sharedCount()).toBe(DEFAULT_LIMIT + 1);
  });

  it("writes what it held back in one statement per window", async () => {
    const probe = limiterApp({ count: 0 });
    const increments = vi.spyOn(ctx.storage.rateLimits, "incrementWindows");
    const writer = await holdTheWriter();
    try {
      for (let i = 0; i < 20; i++) await probe();
    } finally {
      await writer.release();
    }
    increments.mockClear();
    await settleRateLimits(ctx.storage);
    expect(increments).toHaveBeenCalledTimes(1);
    expect(await sharedCount()).toBe(20);
  });

  it("adds nothing held in a window that has ended to the next one", async () => {
    const probe = limiterApp({ count: 0 });
    const writer = await holdTheWriter();
    try {
      for (let i = 0; i < DEFAULT_LIMIT; i++)
        expect((await probe()).status).toBe(200);
    } finally {
      await writer.release();
    }
    advanceClock(WINDOW_MS + 1);
    const next = await probe();
    expect(next.status).toBe(200);
    expect(next.headers.get("X-RateLimit-Remaining")).toBe(
      String(DEFAULT_LIMIT - 1),
    );
    await settleRateLimits(ctx.storage);
    expect(await sharedCount()).toBe(1);
  });

  it("counts held requests once when the next count writes them", async () => {
    const probe = limiterApp({ count: 0 });
    const writer = await holdTheWriter();
    try {
      expect((await probe()).status).toBe(200);
    } finally {
      await writer.release();
    }
    const [first, second] = await Promise.all([
      probe(),
      probe(),
      settleRateLimits(ctx.storage),
    ]);
    const remaining = [first, second]
      .map((res) => Number(res.headers.get("X-RateLimit-Remaining")))
      .sort((a, b) => a - b);
    expect(remaining).toEqual([0, 1]);
    await settleRateLimits(ctx.storage);
    expect(await sharedCount()).toBe(3);
  });
});
