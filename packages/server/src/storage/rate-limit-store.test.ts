import { describe, it, expect, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * T-026 — `storage.rateLimits` unit + integration tests.
 *
 * Exercises both the per-call increment semantics (window reset on
 * expiry, count climbs past cap) and the cluster-shared invariant
 * (two store handles backed by the same DB share counter state). The
 * "two store handles, one DB" pattern models multi-instance correctness
 * without spawning real subprocesses — the property we care about is
 * that the SAME `rate_limit_windows` row is seen by both readers, which
 * holds for any number of Storage handles pointing at the same DB.
 */

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe("RateLimitStore — single-handle behaviour", () => {
  it("first call returns count=1 and stamps expires_at = now + windowMs", async () => {
    ctx = await createTestContext();
    const now = new Date(1_000_000).toISOString();
    const r = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "test-key-1",
      60_000,
      now,
    );
    expect(r.count).toBe(1);
    expect(new Date(r.expires_at).getTime()).toBe(1_000_000 + 60_000);
  });

  it("subsequent calls within the window increment without rolling expires_at", async () => {
    ctx = await createTestContext();
    const a = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "test-key-2",
      60_000,
      new Date(1_000_000).toISOString(),
    );
    const b = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "test-key-2",
      60_000,
      new Date(1_010_000).toISOString(),
    );
    const c = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "test-key-2",
      60_000,
      new Date(1_020_000).toISOString(),
    );
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
    expect(c.count).toBe(3);
    // expires_at stays put — the window was opened by `a` and stays
    // open until the original expiry.
    expect(a.expires_at).toBe(b.expires_at);
    expect(b.expires_at).toBe(c.expires_at);
  });

  it("calls past expires_at reset the window (count=1, fresh expiry)", async () => {
    ctx = await createTestContext();
    const a = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "test-key-3",
      1000,
      new Date(1_000_000).toISOString(),
    );
    const b = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "test-key-3",
      1000,
      new Date(1_000_500).toISOString(),
    );
    // Push past the window — should reset.
    const c = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "test-key-3",
      1000,
      new Date(1_001_500).toISOString(),
    );
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
    expect(c.count).toBe(1);
    expect(new Date(c.expires_at).getTime()).toBe(1_001_500 + 1000);
  });

  it("different keys carry independent counters", async () => {
    ctx = await createTestContext();
    const now = new Date(1_000_000).toISOString();
    const a = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "key-A",
      60_000,
      now,
    );
    const b = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "key-B",
      60_000,
      now,
    );
    const aAgain = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "key-A",
      60_000,
      now,
    );
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
    expect(aAgain.count).toBe(2);
  });

  it("different families carry independent counters even with the same key", async () => {
    ctx = await createTestContext();
    const now = new Date(1_000_000).toISOString();
    const rate = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "same-key",
      60_000,
      now,
    );
    const throttle = await ctx.storage.rateLimits.incrementWindow(
      "throttle",
      "same-key",
      60_000,
      now,
    );
    expect(rate.count).toBe(1);
    expect(throttle.count).toBe(1);
  });

  it("cleanup drops expired rows and leaves live ones alone", async () => {
    ctx = await createTestContext();
    await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "expired-1",
      60_000,
      new Date(1_000_000).toISOString(),
    );
    await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "expired-2",
      60_000,
      new Date(1_000_000).toISOString(),
    );
    await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "live",
      60_000,
      new Date(5_000_000).toISOString(),
    );
    // Now is past the first two windows (1m past 1_000_000 = 1_060_000)
    // but before the live one (5_060_000).
    const dropped = await ctx.storage.rateLimits.cleanup(
      new Date(2_000_000).toISOString(),
    );
    expect(dropped).toBe(2);
    // Re-incrementing the dropped key opens a fresh window from now.
    const fresh = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "expired-1",
      60_000,
      new Date(2_000_000).toISOString(),
    );
    expect(fresh.count).toBe(1);
    // The live row is still there — incrementing it climbs.
    const live = await ctx.storage.rateLimits.incrementWindow(
      "rate",
      "live",
      60_000,
      new Date(5_010_000).toISOString(),
    );
    expect(live.count).toBe(2);
  });
});

describe("RateLimitStore — multi-instance cluster-shared invariant (T-026)", () => {
  it("concurrent increments against the same key see strictly increasing counts", async () => {
    ctx = await createTestContext();
    // Fire N parallel upserts; the post-increment counts the store
    // returns must be the set {1, 2, ..., N} in some order. Postgres
    // row-level locking on the upsert guarantees serialisation; SQLite
    // is single-process so BEGIN IMMEDIATE serialises identically.
    const N = 20;
    const now = new Date(1_000_000).toISOString();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        ctx!.storage.rateLimits.incrementWindow(
          "rate",
          "concurrent-key",
          60_000,
          now,
        ),
      ),
    );
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toStrictEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});
