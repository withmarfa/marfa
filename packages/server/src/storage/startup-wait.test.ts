import { describe, expect, it } from "vitest";
import { isRetryableDbError, withStartupWait } from "./startup-wait.js";

function codeError(code: string): Error {
  const err = new Error(`boom (${code})`);
  (err as Error & { code: string }).code = code;
  return err;
}

describe("isRetryableDbError", () => {
  it("recognizes connection-shaped codes", () => {
    expect(isRetryableDbError(codeError("ECONNREFUSED"))).toBe(true);
    expect(isRetryableDbError(codeError("57P03"))).toBe(true);
    expect(isRetryableDbError(codeError("53300"))).toBe(true);
  });

  it("walks the causal chain", () => {
    const outer = new Error("wrapped");
    (outer as Error & { cause: unknown }).cause = codeError("ETIMEDOUT");
    expect(isRetryableDbError(outer)).toBe(true);
  });

  it("refuses config-shaped failures", () => {
    // Auth failure: identical on every retry, must fail fast.
    expect(isRetryableDbError(codeError("28P01"))).toBe(false);
    expect(
      isRetryableDbError(
        new Error(
          "MARFA_DB_POOL_MODE=transaction requires MARFA_DATABASE_URL_DIRECT",
        ),
      ),
    ).toBe(false);
    expect(isRetryableDbError(null)).toBe(false);
    expect(isRetryableDbError("string")).toBe(false);
  });
});

describe("withStartupWait", () => {
  it("returns immediately on success", async () => {
    let attempts = 0;
    const out = await withStartupWait(
      () => {
        attempts += 1;
        return Promise.resolve("up");
      },
      { budgetMs: 90_000, sleep: () => Promise.resolve() },
    );
    expect(out).toBe("up");
    expect(attempts).toBe(1);
  });

  it("retries retryable failures with backoff until success", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const out = await withStartupWait(
      () => {
        attempts += 1;
        if (attempts < 4) return Promise.reject(codeError("ECONNREFUSED"));
        return Promise.resolve("up");
      },
      {
        budgetMs: 90_000,
        onAttempt: (_a, delayMs) => delays.push(delayMs),
        sleep: () => Promise.resolve(),
      },
    );
    expect(out).toBe("up");
    expect(attempts).toBe(4);
    // Capped exponential: 1s, 2s, 4s.
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it("rethrows a non-retryable failure without retrying", async () => {
    let attempts = 0;
    await expect(
      withStartupWait(
        () => {
          attempts += 1;
          return Promise.reject(codeError("28P01"));
        },
        { budgetMs: 90_000, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow("28P01");
    expect(attempts).toBe(1);
  });

  it("budget zero means today's fail-fast", async () => {
    let attempts = 0;
    await expect(
      withStartupWait(
        () => {
          attempts += 1;
          return Promise.reject(codeError("ECONNREFUSED"));
        },
        { budgetMs: 0, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(attempts).toBe(1);
  });

  it("gives up when the budget is exhausted", async () => {
    // Real clock with a tiny budget: the first computed delay (1s)
    // already overruns it, so the last error rethrows unchanged.
    let attempts = 0;
    await expect(
      withStartupWait(
        () => {
          attempts += 1;
          return Promise.reject(codeError("ECONNREFUSED"));
        },
        { budgetMs: 100 },
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(attempts).toBe(1);
  });
});
