import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { KeyedThrottle, admitThroughLanes } from "./keyed-throttle.js";
import type { Storage } from "../storage/interface.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * A keyed throttle backed by `storage.rateLimits`. The counter is
 * shared via the storage layer, so the test exercises the whole path:
 * throttle → store → upsert → re-read.
 *
 * Covers: cap behavior, window expiry, per-key isolation, per-family
 * isolation, and cross-instance counter sharing.
 *
 * Each test uses a fresh `Storage` so the rate_limit_windows rows
 * don't bleed across cases.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

async function makeStorage(): Promise<Storage> {
  ctx = await createTestContext();
  return ctx.storage;
}

describe("KeyedThrottle", () => {
  it("allows up to `limit` attempts in a window", async () => {
    const storage = await makeStorage();
    const t = new KeyedThrottle(storage, {
      family: "test",
      limit: 3,
      windowMs: 60_000,
    });
    const a = await t.attempt(
      "alice@example.com",
      new Date(1_000_000).toISOString(),
    );
    const b = await t.attempt(
      "alice@example.com",
      new Date(1_000_100).toISOString(),
    );
    const c = await t.attempt(
      "alice@example.com",
      new Date(1_000_200).toISOString(),
    );
    const d = await t.attempt(
      "alice@example.com",
      new Date(1_000_300).toISOString(),
    );
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(true);
    expect(d.allowed).toBe(false);
    expect(d.limit).toBe(3);
    // Counter keeps climbing past the cap — see class docstring.
    expect(d.count).toBe(4);
  });

  it("peeks without counting, and says a key at its cap would refuse the next attempt", async () => {
    const storage = await makeStorage();
    const t = new KeyedThrottle(storage, {
      family: "test",
      limit: 2,
      windowMs: 60_000,
    });
    const at = (ms: number) => new Date(ms).toISOString();
    // Nothing counted yet: a witness that an unseen key reads as open.
    expect(await t.peek("alice", at(1_000_000))).toEqual({ allowed: true });
    await t.attempt("alice", at(1_000_000));
    // One of two used: the next would be allowed. Peeking again and again
    // does not use the other one.
    for (let i = 0; i < 5; i++)
      expect(await t.peek("alice", at(1_000_100))).toEqual({ allowed: true });
    await t.attempt("alice", at(1_000_200));
    expect(await t.peek("alice", at(1_000_300))).toEqual({
      allowed: false,
      resetAt: 1_060_000,
    });
    // The peeks counted nothing: the third attempt is the first refused.
    expect((await t.attempt("alice", at(1_000_400))).count).toBe(3);
    // Once the window has ended the key reads as open again.
    expect(await t.peek("alice", at(1_060_000))).toEqual({ allowed: true });
  });

  it("answers the latest end among the lanes spent, and counts nothing after a refusing lane", async () => {
    const storage = await makeStorage();
    const short = new KeyedThrottle(storage, {
      family: "short",
      limit: 1,
      windowMs: 60_000,
    });
    const long = new KeyedThrottle(storage, {
      family: "long",
      limit: 1,
      windowMs: 600_000,
    });
    const lanes = [
      { throttle: short, key: "k" },
      { throttle: long, key: "k" },
    ];
    expect(await admitThroughLanes(lanes)).toEqual({ allowed: true });
    const refused = await admitThroughLanes(lanes);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      const longRow = await storage.rateLimits.peekWindow(
        "long",
        "k",
        new Date().toISOString(),
      );
      expect(refused.resetAt).toBe(new Date(longRow!.expires_at).getTime());
      // Only the first call counted against the long lane.
      expect(longRow!.count).toBe(1);
    }
  });

  it("resets the counter once the window has elapsed", async () => {
    const storage = await makeStorage();
    const t = new KeyedThrottle(storage, {
      family: "test",
      limit: 2,
      windowMs: 1000,
    });
    const a = await t.attempt(
      "alice@example.com",
      new Date(1_000_000).toISOString(),
    );
    const b = await t.attempt(
      "alice@example.com",
      new Date(1_000_100).toISOString(),
    );
    const c = await t.attempt(
      "alice@example.com",
      new Date(1_000_500).toISOString(),
    );
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    // After window expiry — fresh window. The store's
    // CASE-WHEN-expires_at-in-past branch resets count to 1 and pushes
    // expires_at forward.
    const d = await t.attempt(
      "alice@example.com",
      new Date(1_001_500).toISOString(),
    );
    const e = await t.attempt(
      "alice@example.com",
      new Date(1_001_600).toISOString(),
    );
    expect(d.allowed).toBe(true);
    expect(d.count).toBe(1);
    expect(e.allowed).toBe(true);
  });

  it("each key has an independent window", async () => {
    const storage = await makeStorage();
    const t = new KeyedThrottle(storage, {
      family: "test",
      limit: 1,
      windowMs: 60_000,
    });
    const a = await t.attempt(
      "alice@example.com",
      new Date(1_000_000).toISOString(),
    );
    const b = await t.attempt(
      "alice@example.com",
      new Date(1_000_100).toISOString(),
    );
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
    const c = await t.attempt(
      "bob@example.com",
      new Date(1_000_200).toISOString(),
    );
    expect(c.allowed).toBe(true);
  });

  it("two families keep separate windows for the same key", async () => {
    const storage = await makeStorage();
    const left = new KeyedThrottle(storage, {
      family: "left",
      limit: 1,
      windowMs: 60_000,
    });
    const right = new KeyedThrottle(storage, {
      family: "right",
      limit: 1,
      windowMs: 60_000,
    });
    expect((await left.attempt("k")).allowed).toBe(true);
    expect((await left.attempt("k")).allowed).toBe(false);
    expect((await right.attempt("k")).allowed).toBe(true);
  });

  it("two throttle instances over the same storage share state", async () => {
    // The shared-counter invariant: the count is one budget for a
    // key, however many throttles reach it. Two wrappers over one
    // `Storage` handle rather than two processes, because the row is what
    // the property is about and a subprocess would prove the same thing at
    // a higher price.
    const storage = await makeStorage();
    const left = new KeyedThrottle(storage, {
      family: "test",
      limit: 2,
      windowMs: 60_000,
    });
    const right = new KeyedThrottle(storage, {
      family: "test",
      limit: 2,
      windowMs: 60_000,
    });
    const a = await left.attempt(
      "alice@example.com",
      new Date(1_000_000).toISOString(),
    );
    const b = await right.attempt(
      "alice@example.com",
      new Date(1_000_100).toISOString(),
    );
    const c = await left.attempt(
      "alice@example.com",
      new Date(1_000_200).toISOString(),
    );
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
  });
  it("shares the owner budget atomically across processes and after they restart", async () => {
    ctx = await createTestContext();
    const script = `
      import { createSqliteStorage } from ${JSON.stringify(new URL("../storage/sqlite/index.ts", import.meta.url).href)};
      import { KeyedThrottle } from ${JSON.stringify(new URL("./keyed-throttle.ts", import.meta.url).href)};
      const storage = await createSqliteStorage(process.argv[1]);
      try {
        const throttle = new KeyedThrottle(storage, {
          family: "device-user-code-owner", limit: 10, windowMs: 15 * 60_000,
        });
        const results = [];
        for (let i = 0; i < Number(process.argv[2]); i++)
          results.push(await throttle.attempt("claimed-owner"));
        process.stdout.write(JSON.stringify(results));
      } finally { await storage.close(); }
    `;
    const run = async (attempts: number) => {
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        join(ctx!.tmpDir, "test.db"),
        String(attempts),
      ]);
      return JSON.parse(stdout) as { allowed: boolean; count: number }[];
    };
    const results = (await Promise.all([run(6), run(6), run(6)])).flat();
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.map((result) => result.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 18 }, (_, i) => i + 1),
    );
    expect(await run(1)).toEqual([
      expect.objectContaining({ allowed: false, count: 19 }),
    ]);
  });
});
