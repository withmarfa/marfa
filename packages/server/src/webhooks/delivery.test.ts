import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Item, Webhook, WebhookDelivery } from "@withmarfa/shared";
import type {
  PendingWebhookDelivery,
  WebhookDeliveryStore,
  WebhookStore,
} from "../storage/interface.js";
import {
  publish,
  publishEdge,
  emitReplicated,
  type ItemEvent,
  type EdgeEventWithId,
} from "../pubsub.js";
import {
  WebhookConsumer,
  WebhookPoller,
  deliverWebhookAttempt,
  parseRetryAfter,
  buildSignatureHeader,
} from "./delivery.js";

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
    // Tests that don't exercise the direct path leave this unused; the
    // direct-dispatch tests override with their own stub.
    claimById: () => Promise.resolve(null),
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

describe("WebhookPoller retry behavior", () => {
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
    globalThis.fetch = fetchSpy;

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
    globalThis.fetch = fetchSpy;

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
    globalThis.fetch = fetchSpy;

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

  it("honors Retry-After on 429", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      ),
    );
    globalThis.fetch = fetchSpy;

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
    globalThis.fetch = fetchSpy;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_clamp" })]);
    const poller = new WebhookPoller(store);

    const beforeMs = Date.now();
    await pollOnce(poller);

    const nextAt = calls.markFailed[0]?.nextAttemptAt;
    const delay = new Date(nextAt!).getTime() - beforeMs;
    expect(delay).toBeGreaterThanOrEqual(295_000);
    expect(delay).toBeLessThanOrEqual(300_500);
  });

  it("retries on 5xx and honors Retry-After when present", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 503, headers: { "retry-after": "5" } }),
      ),
    );
    globalThis.fetch = fetchSpy;

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
    globalThis.fetch = fetchSpy;

    const { store, calls } = makeStubStore([makeDelivery({ id: "del_ok" })]);
    const poller = new WebhookPoller(store);
    await pollOnce(poller);

    expect(calls.markSuccess).toEqual([
      { id: "del_ok", statusCode: 204, attempt: 1 },
    ]);
  });

  it("emits a Stripe-style X-Marfa-Signature header signed over timestamp.body", async () => {
    const captured: { header: string | null; body: string } = {
      header: null,
      body: "",
    };
    const fetchSpy = vi.fn(
      (_url: string | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        captured.header = headers.get("x-marfa-signature");
        const b = init?.body;
        captured.body = typeof b === "string" ? b : "";
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const payload = '{"event":"item.created","item":{"id":"abc"}}';
    const secret = "whsec_delivery_test";
    const { store } = makeStubStore([
      makeDelivery({ id: "del_sig", payload, webhook_secret: secret }),
    ]);
    const poller = new WebhookPoller(store);
    await pollOnce(poller);

    expect(captured.body).toBe(payload);
    expect(captured.header).not.toBeNull();
    // Parse `t=<unix>,v1=<hex>` without regex so the test stays in the
    // "no .exec() anywhere" camp the lint rule prefers.
    const parts = captured.header!.split(",");
    expect(parts).toHaveLength(2);
    expect(parts[0]!.startsWith("t=")).toBe(true);
    expect(parts[1]!.startsWith("v1=")).toBe(true);
    const ts = parts[0]!.slice(2);
    const sig = parts[1]!.slice(3);
    // Re-derive the signature and assert equality.
    const computed = createHmac("sha256", secret)
      .update(`${ts}.${payload}`)
      .digest("hex");
    expect(sig).toBe(computed);
    // Header should match buildSignatureHeader's output for the same inputs.
    expect(buildSignatureHeader(ts, payload, secret)).toBe(captured.header);
  });
});

// ---------------------------------------------------------------------------
// deliverWebhookAttempt — shared helper used by both the poller and the
// direct-dispatch fast path. Verifies the `direct` flag and the short
// timeout behavior the consumer relies on.
// ---------------------------------------------------------------------------

describe("deliverWebhookAttempt (direct fast path)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("writes markSuccess on 2xx when invoked with direct=true", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    globalThis.fetch = fetchSpy;

    const { store, calls } = makeStubStore([]);
    const delivery = makeDelivery({ id: "del_direct_ok" });
    await deliverWebhookAttempt(store, delivery, 5_000, true);

    expect(calls.markSuccess).toEqual([
      { id: "del_direct_ok", statusCode: 200, attempt: 1 },
    ]);
    expect(calls.markFailed).toEqual([]);
  });

  it("aborts on the shorter 5s direct timeout without hanging the caller", async () => {
    // Resolve only when the AbortSignal fires — simulates a slow receiver.
    const fetchSpy = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.useFakeTimers();
    const { store, calls } = makeStubStore([]);
    const delivery = makeDelivery({ id: "del_direct_slow" });
    const attemptP = deliverWebhookAttempt(store, delivery, 5_000, true);
    await vi.advanceTimersByTimeAsync(5_001);
    await attemptP;

    // No success, one retry scheduled (not dead-letter — network errors
    // follow the retry path).
    expect(calls.markSuccess).toEqual([]);
    expect(calls.markFailed).toHaveLength(1);
    expect(calls.markFailed[0]?.nextAttemptAt).not.toBeNull();
  });

  it("when claimById returns null, tryDirectDispatch is a silent no-op", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    globalThis.fetch = fetchSpy;

    // A store whose `schedule` returns an id, but whose `claimById`
    // always returns null — i.e. the poller or another direct worker
    // got there first.
    const store: WebhookDeliveryStore = {
      log: () => Promise.resolve(),
      list: () => Promise.resolve([] as WebhookDelivery[]),
      schedule: () => Promise.resolve("del_raced"),
      getPending: () => Promise.resolve([]),
      claimById: () => Promise.resolve(null),
      markSuccess: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
      markDeadLetter: () => Promise.resolve(),
    };

    const webhook: Webhook = {
      id: "wh_raced",
      url: "https://example.test/hook",
      secret: "s",
      events: ["item.created"],
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const webhookStore: WebhookStore = {
      create: () => Promise.resolve(webhook),
      list: () => Promise.resolve([webhook]),
      get: () => Promise.resolve(webhook),
      update: () => Promise.resolve(webhook),
      delete: () => Promise.resolve(),
      listActive: () => Promise.resolve([webhook]),
      count: () => Promise.resolve(1),
    };

    const consumer = new WebhookConsumer(webhookStore, store);
    consumer.start();

    const event: ItemEvent = {
      type: "created",
      item: {
        id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
        type: "core.note",
        version: 1,
        state: "active",
        tier: "library",
        source: "test",
        properties: { title: "x" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as Item,
    };
    await publish(event);
    // Let the consumer's async iterator tick and the fire-and-forget
    // direct-dispatch attempt settle.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    consumer.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when claimById returns the row, tryDirectDispatch fires HTTP", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    globalThis.fetch = fetchSpy;

    let markedSuccess = false;
    const claimed: PendingWebhookDelivery = {
      id: "del_fast",
      webhook_id: "wh_fast",
      event: "item.created",
      payload: '{"event":"item.created"}',
      webhook_url: "https://example.test/hook",
      webhook_secret: "s",
      attempt: 0,
      max_attempts: 4,
    };
    const store: WebhookDeliveryStore = {
      log: () => Promise.resolve(),
      list: () => Promise.resolve([] as WebhookDelivery[]),
      schedule: () => Promise.resolve(claimed.id),
      getPending: () => Promise.resolve([]),
      claimById: () => Promise.resolve(claimed),
      markSuccess: () => {
        markedSuccess = true;
        return Promise.resolve();
      },
      markFailed: () => Promise.resolve(),
      markDeadLetter: () => Promise.resolve(),
    };

    const webhook: Webhook = {
      id: "wh_fast",
      url: "https://example.test/hook",
      secret: "s",
      events: ["item.created"],
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const webhookStore: WebhookStore = {
      create: () => Promise.resolve(webhook),
      list: () => Promise.resolve([webhook]),
      get: () => Promise.resolve(webhook),
      update: () => Promise.resolve(webhook),
      delete: () => Promise.resolve(),
      listActive: () => Promise.resolve([webhook]),
      count: () => Promise.resolve(1),
    };

    const consumer = new WebhookConsumer(webhookStore, store);
    consumer.start();

    const event: ItemEvent = {
      type: "created",
      item: {
        id: "01HYYYYYYYYYYYYYYYYYYYYYYY",
        type: "core.note",
        version: 1,
        state: "active",
        tier: "library",
        source: "test",
        properties: { title: "x" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as Item,
    };
    const t0 = Date.now();
    await publish(event);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    consumer.stop();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(markedSuccess).toBe(true);
    // Sub-second on the happy path — the whole point of direct dispatch.
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("direct path produces byte-identical signatures to the poller path", async () => {
    const captured: { headers: string[] } = { headers: [] };
    const fetchSpy = vi.fn(
      (_url: string | URL, init?: RequestInit): Promise<Response> => {
        const h = new Headers(init?.headers);
        const sig = h.get("x-marfa-signature");
        if (sig) captured.headers.push(sig);
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { store } = makeStubStore([]);
    const delivery: PendingWebhookDelivery = makeDelivery({
      id: "del_sig_parity",
      payload: '{"event":"item.created"}',
      webhook_secret: "whsec_parity",
    });

    await deliverWebhookAttempt(store, delivery, 5_000, true);
    await deliverWebhookAttempt(store, delivery, 10_000, false);

    // Both paths hit the same signing helper; headers differ only in the
    // embedded timestamp, and the HMAC is derived from that timestamp plus
    // the identical payload. Re-derive and assert equality.
    expect(captured.headers).toHaveLength(2);
    for (const header of captured.headers) {
      const [tPart, v1Part] = header.split(",");
      const ts = tPart!.slice(2);
      const sig = v1Part!.slice(3);
      const expected = createHmac("sha256", delivery.webhook_secret)
        .update(`${ts}.${delivery.payload}`)
        .digest("hex");
      expect(sig).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// WebhookConsumer — replicated events are the origin process's to deliver
// ---------------------------------------------------------------------------

describe("WebhookConsumer remote-event skip", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("never schedules a delivery for an event replicated from another process", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    globalThis.fetch = fetchSpy;

    let scheduled = 0;
    const store: WebhookDeliveryStore = {
      log: () => Promise.resolve(),
      list: () => Promise.resolve([] as WebhookDelivery[]),
      schedule: () => {
        scheduled += 1;
        return Promise.resolve("del_remote");
      },
      getPending: () => Promise.resolve([]),
      claimById: () => Promise.resolve(null),
      markSuccess: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
      markDeadLetter: () => Promise.resolve(),
    };

    const webhook: Webhook = {
      id: "wh_remote",
      url: "https://example.test/hook",
      secret: "s",
      events: ["item.created", "edge.created"],
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const webhookStore: WebhookStore = {
      create: () => Promise.resolve(webhook),
      list: () => Promise.resolve([webhook]),
      get: () => Promise.resolve(webhook),
      update: () => Promise.resolve(webhook),
      delete: () => Promise.resolve(),
      listActive: () => Promise.resolve([webhook]),
      count: () => Promise.resolve(1),
    };

    const consumer = new WebhookConsumer(webhookStore, store);
    consumer.start();

    emitReplicated({
      type: "created",
      item: {
        id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
        type: "core.note",
        version: 1,
        state: "active",
        tier: "library",
        source: "test",
        properties: { title: "replicated elsewhere" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as Item,
      originatingConnectionId: null,
      hopCount: 0,
      eventId: 42n,
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    consumer.stop();

    expect(scheduled).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips a replicated edge event but still delivers a local one, so the filter cannot over-reach", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    globalThis.fetch = fetchSpy;

    let scheduled = 0;
    const store: WebhookDeliveryStore = {
      log: () => Promise.resolve(),
      list: () => Promise.resolve([] as WebhookDelivery[]),
      schedule: () => {
        scheduled += 1;
        return Promise.resolve(`del_edge_${String(scheduled)}`);
      },
      getPending: () => Promise.resolve([]),
      claimById: () => Promise.resolve(null),
      markSuccess: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
      markDeadLetter: () => Promise.resolve(),
    };

    const webhook: Webhook = {
      id: "wh_edge",
      url: "https://example.test/hook",
      secret: "s",
      events: ["edge.created"],
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const webhookStore: WebhookStore = {
      create: () => Promise.resolve(webhook),
      list: () => Promise.resolve([webhook]),
      get: () => Promise.resolve(webhook),
      update: () => Promise.resolve(webhook),
      delete: () => Promise.resolve(),
      listActive: () => Promise.resolve([webhook]),
      count: () => Promise.resolve(1),
    };

    const consumer = new WebhookConsumer(webhookStore, store);
    consumer.start();

    const edge = {
      id: "edge_remote_skip",
      edge_type: "references",
      source_id: "01HAAAAAAAAAAAAAAAAAAAAAAA",
      target_id: "01HBBBBBBBBBBBBBBBBBBBBBBB",
      created_at: new Date().toISOString(),
    } as unknown as EdgeEventWithId["edge"];

    emitReplicated({
      type: "edge_created",
      edge,
      originatingConnectionId: null,
      hopCount: 0,
      eventId: 43n,
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const scheduledAfterRemote = scheduled;

    await publishEdge({ type: "edge_created", edge });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    consumer.stop();

    expect(scheduledAfterRemote).toBe(0);
    expect(scheduled).toBe(1);
  });
});
