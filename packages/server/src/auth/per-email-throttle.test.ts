import { describe, it, expect, afterEach } from "vitest";
import { PerEmailThrottle } from "./per-email-throttle.js";
import type { Storage } from "../storage/interface.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Per-email throttle backed by `storage.rateLimits`. The counter is
 * shared via the storage layer, so the test exercises the whole path:
 * throttle → store → upsert → re-read.
 *
 * Covers: cap behavior, lowercase normalization, window expiry,
 * per-email isolation, and cross-instance counter sharing.
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

describe("PerEmailThrottle", () => {
  it("allows up to `limit` attempts in a window", async () => {
    const storage = await makeStorage();
    const t = new PerEmailThrottle(storage, { limit: 3, windowMs: 60_000 });
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

  it("normalizes email to lowercase so casing doesn't defeat the cap", async () => {
    const storage = await makeStorage();
    const t = new PerEmailThrottle(storage, { limit: 2, windowMs: 60_000 });
    const a = await t.attempt(
      "Alice@Example.com",
      new Date(1_000_000).toISOString(),
    );
    const b = await t.attempt(
      "alice@example.com",
      new Date(1_000_100).toISOString(),
    );
    const c = await t.attempt(
      "ALICE@EXAMPLE.COM",
      new Date(1_000_200).toISOString(),
    );
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
  });

  it("resets the counter once the window has elapsed", async () => {
    const storage = await makeStorage();
    const t = new PerEmailThrottle(storage, { limit: 2, windowMs: 1000 });
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

  it("each email has an independent window", async () => {
    const storage = await makeStorage();
    const t = new PerEmailThrottle(storage, { limit: 1, windowMs: 60_000 });
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

  it("two throttle instances over the same storage share state", async () => {
    // The shared-counter invariant: the count is one budget for an
    // address, however many throttles reach it. Two wrappers over one
    // `Storage` handle rather than two processes, because the row is what
    // the property is about and a subprocess would prove the same thing at
    // a higher price.
    const storage = await makeStorage();
    const left = new PerEmailThrottle(storage, { limit: 2, windowMs: 60_000 });
    const right = new PerEmailThrottle(storage, { limit: 2, windowMs: 60_000 });
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
});
