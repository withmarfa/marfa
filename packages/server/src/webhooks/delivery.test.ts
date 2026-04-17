import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookDelivery } from "@mymehq/shared";
import type { WebhookDeliveryStore } from "../storage/interface.js";
import { WebhookPoller, parseRetryAfter } from "./delivery.js";

// ---------------------------------------------------------------------------
// parseRetryAfter — header parsing
// ---------------------------------------------------------------------------

describe("parseRetryAfter", () => {
  it("returns null for missing or blank values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
  });

  it("parses delta-seconds form to milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("1")).toBe(1_000);
  });

  it("clamps very large delta-seconds to the 5-minute ceiling", () => {
    // 99 999 999 seconds would be ~3 years — must clamp.
    expect(parseRetryAfter("99999999")).toBe(5 * 60 * 1000);
  });

  it("rejects zero and negative delta-seconds", () => {
    expect(parseRetryAfter("0")).toBeNull();
    expect(parseRetryAfter("-1")).toBeNull();
  });

  it("parses HTTP-date form to a future delta", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).not.toBeNull();
    // Should be roughly 45s, allow a small clock-tick tolerance.
    expect(result).toBeGreaterThan(40_000);
    expect(result).toBeLessThanOrEqual(45_000);
  });

  it("returns null for HTTP-date in the past", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBeNull();
  });

  it("returns null for completely unparseable garbage", () => {
    expect(parseRetryAfter("not-a-real-header")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WebhookPoller — retry routing on response codes
// ---------------------------------------------------------------------------

interface PendingDelivery {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  webhook_url: string;
  webhook_secret: string;
  attempt: number;
  max_attempts: number;
}

function makeDelivery(
  overrides: Partial<PendingDelivery> = {},
): PendingDelivery {
  return {
    id: "del_1",
    webhook_id: "wh_1",
    event: "item.created",
    payload: '{"event":"item.created"}',
    webhook_url: "https://example.test/hook",
    webhook_secret: "shh",
    attempt: 0,
    max_attempts: 4,
    ...overrides,
  };
}

interface StoreCalls {
  markSuccess: { id: string; statusCode: number; attempt: number }[];
  markFailed: {
    id: string;
    statusCode: number | undefined;
    error: string;
    attempt: number;
    nextAttemptAt: string | null;
  }[];
  markDeadLetter: { id: string }[];
}

function makeStubStore(pending: PendingDelivery[]): {
  store: WebhookDeliveryStore;
  calls: StoreCalls;
} {
  const calls: StoreCalls = {
    markSuccess: [],
    markFailed: [],
    markDeadLetter: [],
  };

  const store: WebhookDeliveryStore = {
    log: () => Promise.resolve(),
    list: () => Promise.resolve([] as WebhookDelivery[]),
    schedule: () => Promise.resolve("del_x"),
    getPending: () => Promise.resolve(pending),
    markSuccess: (id, statusCode, attempt) => {
      calls.markSuccess.push({ id, statusCode, attempt });
      return Promise.resolve();
    },
    markFailed: (id, statusCode, error, attempt, nextAttemptAt) => {
      calls.markFailed.push({
        id,
        statusCode,
        error,
        attempt,
        nextAttemptAt,
      });
      return Promise.resolve();
    },
    markDeadLetter: (id) => {
      calls.markDeadLetter.push({ id });
      return Promise.resolve();
    },
  };

  return { store, calls };
}

/** Drain `poll()` once. The poller is started for its side-effect of an
 *  immediate poll, then stopped to clear the 30s interval. We then yield
 *  to the microtask queue until the spies have settled. */
async function pollOnce(poller: WebhookPoller): Promise<void> {
  poller.start();
  poller.stop();
  // Allow the immediate poll() promise chain to settle.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("WebhookPoller retry behaviour", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("dead-letters generic 4xx (e.g. 400)", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 400 })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_400" })]);
    const poller = new WebhookPoller(store);
    await pollOnce(poller);

    expect(calls.markDeadLetter).toEqual([{ id: "del_400" }]);
    expect(calls.markFailed).toEqual([]);
  });

  it("retries on 408 instead of dead-lettering", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 408 })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_408" })]);
    const poller = new WebhookPoller(store);
    await pollOnce(poller);

    expect(calls.markDeadLetter).toEqual([]);
    expect(calls.markFailed).toHaveLength(1);
    expect(calls.markFailed[0]?.statusCode).toBe(408);
    expect(calls.markFailed[0]?.nextAttemptAt).not.toBeNull();
  });

  it("retries on 429 and falls back to default schedule when Retry-After is absent", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 429 })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_429" })]);
    const poller = new WebhookPoller(store);

    const beforeMs = Date.now();
    await pollOnce(poller);

    expect(calls.markFailed).toHaveLength(1);
    const nextAt = calls.markFailed[0]?.nextAttemptAt;
    expect(nextAt).toBeTruthy();
    // Default first-retry delay is 1000ms (RETRY_DELAYS[0]).
    const delay = new Date(nextAt!).getTime() - beforeMs;
    expect(delay).toBeGreaterThanOrEqual(900);
    expect(delay).toBeLessThan(2000);
  });

  it("honours Retry-After on 429", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_429ra" })]);
    const poller = new WebhookPoller(store);

    const beforeMs = Date.now();
    await pollOnce(poller);

    expect(calls.markFailed).toHaveLength(1);
    const nextAt = calls.markFailed[0]?.nextAttemptAt;
    const delay = new Date(nextAt!).getTime() - beforeMs;
    // ~30s, allow a generous tolerance for test-runner overhead.
    expect(delay).toBeGreaterThanOrEqual(29_500);
    expect(delay).toBeLessThan(31_000);
  });

  it("clamps an absurd Retry-After to the 5-minute ceiling", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "99999999" },
        }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_clamp" })]);
    const poller = new WebhookPoller(store);

    const beforeMs = Date.now();
    await pollOnce(poller);

    const nextAt = calls.markFailed[0]?.nextAttemptAt;
    const delay = new Date(nextAt!).getTime() - beforeMs;
    expect(delay).toBeGreaterThanOrEqual(295_000);
    expect(delay).toBeLessThanOrEqual(300_500);
  });

  it("retries on 5xx and honours Retry-After when present", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 503, headers: { "retry-after": "5" } }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_503" })]);
    const poller = new WebhookPoller(store);

    const beforeMs = Date.now();
    await pollOnce(poller);

    const nextAt = calls.markFailed[0]?.nextAttemptAt;
    const delay = new Date(nextAt!).getTime() - beforeMs;
    expect(delay).toBeGreaterThanOrEqual(4_500);
    expect(delay).toBeLessThan(6_000);
    expect(calls.markFailed[0]?.statusCode).toBe(503);
  });

  it("marks success on 2xx", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_ok" })]);
    const poller = new WebhookPoller(store);
    await pollOnce(poller);

    expect(calls.markSuccess).toEqual([
      { id: "del_ok", statusCode: 204, attempt: 1 },
    ]);
  });
});
