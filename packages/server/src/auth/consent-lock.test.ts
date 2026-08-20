/**
 * Guards `consentLockDepth`, the arrival count the concurrency tests in
 * `routes/auth-consent-skip.test.ts` and `routes/auth-grant-revoke.test.ts`
 * wait on before releasing the request that holds the lock.
 *
 * Those tests are only meaningful while the count is honest. If it ever
 * over-reported, they would release the holder before the competing
 * request had queued, run the two in sequence, and still pass — which is
 * precisely the silent loss of coverage the count was added to prevent.
 * So the count is checked here directly rather than trusted.
 */
import { describe, it, expect } from "vitest";
import {
  withConsentLock,
  consentLockDepth,
  setConsentLockBackend,
} from "./consent-lock.js";

/** A promise plus its resolver, for holding a critical section open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("consentLockDepth", () => {
  it("is zero for a pair nobody is working on", () => {
    expect(consentLockDepth("client_idle", "user_idle")).toBe(0);
  });

  it("counts the holder, then the waiter queued behind it, then drains", async () => {
    const gate = deferred();
    const holder = withConsentLock("client_a", "user_a", async () => {
      await gate.promise;
    });
    // The holder registers before its first await, so the count is
    // already right by the time control returns here.
    expect(consentLockDepth("client_a", "user_a")).toBe(1);

    const waiterGate = deferred();
    const waiter = withConsentLock("client_a", "user_a", async () => {
      await waiterGate.promise;
    });
    // A caller counts from the moment it starts waiting, not from the
    // moment it gets its turn — the tests need to see it arrive while
    // the holder is still parked.
    expect(consentLockDepth("client_a", "user_a")).toBe(2);

    gate.resolve();
    await holder;
    expect(consentLockDepth("client_a", "user_a")).toBe(1);

    waiterGate.resolve();
    await waiter;
    expect(consentLockDepth("client_a", "user_a")).toBe(0);
  });

  it("counts each pair separately", async () => {
    const gate = deferred();
    const held = withConsentLock("client_b", "user_b", async () => {
      await gate.promise;
    });
    expect(consentLockDepth("client_b", "user_b")).toBe(1);
    expect(consentLockDepth("client_b", "user_other")).toBe(0);
    expect(consentLockDepth("client_other", "user_b")).toBe(0);
    gate.resolve();
    await held;
    expect(consentLockDepth("client_b", "user_b")).toBe(0);
  });

  it("drains when the critical section throws, so a failure cannot strand the count", async () => {
    await expect(
      withConsentLock("client_c", "user_c", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(consentLockDepth("client_c", "user_c")).toBe(0);
  });
});

describe("cross-process backend composition", () => {
  it("routes the critical section through the backend, composed inside the in-process queue", async () => {
    // The load-bearing ordering claim: the in-process queue serializes
    // same-key callers BEFORE the backend runs, so the backend never has
    // two concurrent invocations for one key even when the backend
    // itself provides no exclusion (this stub deliberately does not).
    let inBackend = 0;
    let peak = 0;
    const keys: string[] = [];
    setConsentLockBackend(async (key, fn) => {
      keys.push(key);
      inBackend += 1;
      peak = Math.max(peak, inBackend);
      try {
        return await fn();
      } finally {
        inBackend -= 1;
      }
    });
    try {
      const results = await Promise.all([
        withConsentLock("client_d", "user_d", async () => {
          await new Promise((r) => setTimeout(r, 50));
          return "first";
        }),
        withConsentLock("client_d", "user_d", () => Promise.resolve("second")),
      ]);
      expect(results).toEqual(["first", "second"]);
      expect(peak).toBe(1);
      expect(keys).toEqual(["client_d:user_d", "client_d:user_d"]);
    } finally {
      setConsentLockBackend(null);
    }
  });

  it("runs the critical section directly when no backend is set", async () => {
    const result = await withConsentLock("client_e", "user_e", () =>
      Promise.resolve(42),
    );
    expect(result).toBe(42);
  });
});
