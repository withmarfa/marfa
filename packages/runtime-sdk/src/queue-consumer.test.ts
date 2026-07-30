import { describe, it, expect, beforeEach } from "vitest";
import {
  consumeBatch,
  type ConsumerEnvironment,
  type DlqProducer,
} from "./queue-consumer.js";
import {
  registerScheduleHandler,
  registerWebhookHandler,
  registerItemEventHandler,
  _resetHandlers,
} from "./handlers.js";
import { createInMemoryStorage } from "./in-memory-storage.js";
import type {
  ItemEventMessage,
  ScheduleMessage,
  WebhookMessage,
  QueueMessage,
} from "./types.js";
import { nextHopMetadata, SDK_DEFAULT_HOP_BUDGET } from "./types.js";

/**
 * Test-only `Message<T>` constructor. The canonical impl lives at
 * `packages/runtime-test/src/in-memory-queue.ts:createMessage`; we
 * inline a minimal version here because runtime-test depends on
 * runtime-sdk (importing the canonical impl would invert that). The
 * shape mirrors Cloudflare's `Message<T>` (id, timestamp, body,
 * attempts, ack, retry) plus `acked` / `retried` / `retryDelaySeconds`
 * spies for direct assertion. Keep the two impls in sync — the
 * envelope is a single contract, just doubled to break the dep cycle.
 */
interface TestMessage<T> {
  readonly body: T;
  readonly id: string;
  readonly timestamp: Date;
  attempts: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
  // Test-only:
  acked: boolean;
  retried: boolean;
  retryDelaySeconds?: number;
}

function makeMsg<T extends QueueMessage>(
  body: T,
  attempts = 1,
): TestMessage<T> {
  const m: TestMessage<T> = {
    body,
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date(),
    attempts,
    acked: false,
    retried: false,
    ack(): void {
      m.acked = true;
    },
    retry(opts?: { delaySeconds?: number }): void {
      m.retried = true;
      m.retryDelaySeconds = opts?.delaySeconds;
      m.attempts++;
    },
  };
  return m;
}

const SCHED = (over: Partial<ScheduleMessage> = {}): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "demo",
  connection_id: "conn_a",
  scheduled_for_ms: 1000,
  ...over,
});

const WEBHOOK = (over: Partial<WebhookMessage> = {}): WebhookMessage => ({
  kind: "webhook",
  integration_name: "demo",
  connection_id: "conn_a",
  delivery_id: "d_1",
  headers: {},
  body_base64: "",
  verified_at_ms: 1000,
  ...over,
});

function makeEnv(): ConsumerEnvironment {
  const stores = new Map<string, ReturnType<typeof createInMemoryStorage>>();
  return {
    apiUrl: "http://localhost:0",
    integrationName: "demo",
    storageFor: (id) => {
      let s = stores.get(id);
      if (!s) {
        s = createInMemoryStorage();
        stores.set(id, s);
      }
      return s;
    },
    mintCredential: (id) =>
      Promise.resolve({
        api_key: "marfa_k1_test",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        connection_id: id,
      }),
    echo: { echo_ttl_seconds: 60 },
  };
}

describe("consumeBatch", () => {
  beforeEach(() => {
    _resetHandlers();
  });

  it("acks every message when handler returns ok", async () => {
    registerScheduleHandler(() => Promise.resolve({ ok: true }));
    const m1 = makeMsg(SCHED());
    const m2 = makeMsg(SCHED({ connection_id: "conn_b" }));
    const outcome = await consumeBatch(makeEnv(), [m1, m2]);
    expect(outcome).toEqual({ acked: 2, retried: 0, failed: 0 });
    expect(m1.acked).toBe(true);
    expect(m2.acked).toBe(true);
    expect(m1.retried).toBe(false);
    expect(m2.retried).toBe(false);
  });

  it("acks messages addressed to other integrations without dispatching", async () => {
    let dispatched = 0;
    registerScheduleHandler(() => {
      dispatched++;
      return Promise.resolve({ ok: true });
    });
    const m1 = makeMsg(SCHED({ integration_name: "demo" }));
    const m2 = makeMsg(SCHED({ integration_name: "other" }));
    const m3 = makeMsg(SCHED({ integration_name: "demo" }));
    const outcome = await consumeBatch(makeEnv(), [m1, m2, m3]);
    // Other-integration messages are acked to leave the shared queue,
    // not dispatched — the handler fires only for the two matching.
    expect(outcome.acked).toBe(3);
    expect(outcome.retried).toBe(0);
    expect(dispatched).toBe(2);
    expect(m1.acked).toBe(true);
    expect(m2.acked).toBe(true);
    expect(m3.acked).toBe(true);
  });

  it("retries (per-message) when a handler returns retry:true", async () => {
    registerWebhookHandler(() =>
      Promise.resolve({ ok: false, retry: true, reason: "rate_limited" }),
    );
    const m = makeMsg(WEBHOOK());
    const outcome = await consumeBatch(makeEnv(), [m]);
    // No throw — per-message retry has informed Cloudflare via msg.retry.
    expect(outcome).toEqual({ acked: 0, retried: 1, failed: 0 });
    expect(m.retried).toBe(true);
    expect(m.acked).toBe(false);
    // First attempt → 2^0 = 1 s backoff.
    expect(m.retryDelaySeconds).toBe(1);
  });

  it("only retries the failing message in a partial-failure batch", async () => {
    // The whole point of per-message ack: a partial failure DOES NOT
    // re-deliver the successful messages on retry. Without per-message
    // ack, Cloudflare would re-deliver all three messages including the
    // two that already processed. With per-message ack, message #2
    // retries; #1 and #3 stay acked.
    let invocations = 0;
    registerScheduleHandler(() => {
      invocations++;
      // Fail only the second message (invocations === 2).
      if (invocations === 2) {
        return Promise.resolve({
          ok: false as const,
          retry: true,
          reason: "second-fails",
        });
      }
      return Promise.resolve({ ok: true });
    });
    const m1 = makeMsg(SCHED({ connection_id: "conn_a" }));
    const m2 = makeMsg(SCHED({ connection_id: "conn_b" }));
    const m3 = makeMsg(SCHED({ connection_id: "conn_c" }));
    const outcome = await consumeBatch(makeEnv(), [m1, m2, m3]);
    expect(outcome).toEqual({ acked: 2, retried: 1, failed: 0 });
    expect(m1.acked).toBe(true);
    expect(m1.retried).toBe(false);
    expect(m2.acked).toBe(false);
    expect(m2.retried).toBe(true);
    expect(m3.acked).toBe(true);
    expect(m3.retried).toBe(false);
  });

  it("retries with exponential backoff capped at 60s", async () => {
    registerScheduleHandler(() =>
      Promise.resolve({ ok: false, retry: true, reason: "x" }),
    );
    // attempts=1 → 2^0 = 1; attempts=2 → 2^1 = 2; attempts=4 → 2^3 = 8;
    // attempts=7 → 2^6 = 64 → capped at 60.
    const fresh = makeMsg(SCHED(), 1);
    await consumeBatch(makeEnv(), [fresh]);
    expect(fresh.retryDelaySeconds).toBe(1);

    const second = makeMsg(SCHED(), 2);
    await consumeBatch(makeEnv(), [second]);
    expect(second.retryDelaySeconds).toBe(2);

    const fourth = makeMsg(SCHED(), 4);
    await consumeBatch(makeEnv(), [fourth]);
    expect(fourth.retryDelaySeconds).toBe(8);

    const seventh = makeMsg(SCHED(), 7);
    await consumeBatch(makeEnv(), [seventh]);
    expect(seventh.retryDelaySeconds).toBe(60);
  });

  it("acks permanent failures (retry:false) and counts them", async () => {
    registerWebhookHandler(() =>
      Promise.resolve({
        ok: false,
        retry: false,
        reason: "missing_required_field",
      }),
    );
    const m = makeMsg(WEBHOOK());
    const outcome = await consumeBatch(makeEnv(), [m]);
    expect(outcome).toEqual({ acked: 0, retried: 0, failed: 1 });
    expect(m.acked).toBe(true);
    expect(m.retried).toBe(false);
  });

  it("retries on a first-attempt throw, acks-and-logs on a retried-attempt throw", async () => {
    registerScheduleHandler(() => Promise.reject(new Error("kaboom")));

    // First attempt: handler throws → retry once.
    const first = makeMsg(SCHED(), 1);
    const firstOutcome = await consumeBatch(makeEnv(), [first]);
    expect(firstOutcome).toEqual({ acked: 0, retried: 1, failed: 0 });
    expect(first.retried).toBe(true);
    expect(first.retryDelaySeconds).toBe(1);

    // Subsequent attempt (attempts > 1): same throw → ack+log, no
    // infinite loop on a persistent programming error.
    const retried = makeMsg(SCHED(), 2);
    const retriedOutcome = await consumeBatch(makeEnv(), [retried]);
    expect(retriedOutcome).toEqual({ acked: 0, retried: 0, failed: 1 });
    expect(retried.acked).toBe(true);
    expect(retried.retried).toBe(false);
  });

  it("logs to console.error when buildConnectionContext throws", async () => {
    // When the queue consumer's credential mint fails (e.g. broker
    // secrets missing on the Worker), the throw is caught by the
    // dispatch try/catch but the activity-emit backstop downstream also
    // can't reach Marfa. The console.error is the only visible signal in
    // that degraded mode.
    registerScheduleHandler(() => Promise.resolve({ ok: true }));
    const env: ConsumerEnvironment = {
      ...makeEnv(),
      mintCredential: () =>
        Promise.reject(
          new Error(
            "lease broker returned 500: undefined/lease/conn_a/runtime",
          ),
        ),
    };
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };
    try {
      const msg = makeMsg(SCHED(), 1);
      await consumeBatch(env, [msg]);
      // First-attempt throws retry, so the message ends in retried — but
      // the console.error must fire regardless of the retry/ack outcome.
      expect(msg.retried).toBe(true);
    } finally {
      console.error = originalError;
    }
    // Operator-visible signal: a single line with the integration name,
    // connection id, error class, and message — enough to grep in tail
    // / Cloudflare logs and act on without spelunking the activity log.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const line = errors[0];
    expect(line).toContain("[runtime-sdk:consumeBatch]");
    expect(line).toContain("dispatch threw");
    expect(line).toContain("schedule");
    expect(line).toContain("conn_a");
    expect(line).toContain("demo");
    expect(line).toContain("Error");
    expect(line).toContain("lease broker returned 500");
  });

  it("acks-and-skips messages whose space_id mismatches env.spaceId", async () => {
    let dispatched = 0;
    registerScheduleHandler(() => {
      dispatched++;
      return Promise.resolve({ ok: true });
    });
    const env: ConsumerEnvironment = { ...makeEnv(), spaceId: "space-A" };
    const matchA = makeMsg(SCHED({ space_id: "space-A" }));
    const mismatchB = makeMsg(SCHED({ space_id: "space-B" }));
    const outcome = await consumeBatch(env, [matchA, mismatchB]);
    expect(outcome.acked).toBe(2);
    expect(outcome.retried).toBe(0);
    expect(dispatched).toBe(1);
    expect(matchA.acked).toBe(true);
    expect(mismatchB.acked).toBe(true);
  });

  it("dispatches messages with no space_id when env.spaceId is set (single-space compat)", async () => {
    let dispatched = 0;
    registerScheduleHandler(() => {
      dispatched++;
      return Promise.resolve({ ok: true });
    });
    const env: ConsumerEnvironment = { ...makeEnv(), spaceId: "space-A" };
    const m = makeMsg(SCHED());
    const outcome = await consumeBatch(env, [m]);
    expect(outcome.acked).toBe(1);
    expect(dispatched).toBe(1);
  });

  it("refuses to dispatch reactive item-events past the hop budget", async () => {
    let dispatched = 0;
    registerItemEventHandler(() => {
      dispatched++;
      return Promise.resolve({ ok: true });
    });
    const env: ConsumerEnvironment = { ...makeEnv(), hopBudget: 2 };
    const overBudget: ItemEventMessage = {
      kind: "item-event",
      integration_name: "demo",
      connection_id: "conn_a",
      event_type: "item.created",
      item_id: "item_x",
      cycle: { originating_connection_id: "conn-orig", hop_count: 2 },
      payload: {},
    };
    const m = makeMsg(overBudget);
    const outcome = await consumeBatch(env, [m]);
    expect(outcome.acked).toBe(1);
    expect(dispatched).toBe(0);
    // Hop-budget refusal acks (so the message leaves the queue) — it's
    // a permanent decision, not a transient one to retry.
    expect(m.acked).toBe(true);
  });

  it("dispatches reactive item-events under the hop budget", async () => {
    let dispatched = 0;
    registerItemEventHandler(() => {
      dispatched++;
      return Promise.resolve({ ok: true });
    });
    const env: ConsumerEnvironment = { ...makeEnv(), hopBudget: 5 };
    const ok: ItemEventMessage = {
      kind: "item-event",
      integration_name: "demo",
      connection_id: "conn_a",
      event_type: "item.created",
      item_id: "item_x",
      cycle: { originating_connection_id: "conn-orig", hop_count: 1 },
      payload: {},
    };
    const outcome = await consumeBatch(env, [makeMsg(ok)]);
    expect(outcome.acked).toBe(1);
    expect(dispatched).toBe(1);
  });

  it("falls back to SDK_DEFAULT_HOP_BUDGET when env.hopBudget is unset", async () => {
    let dispatched = 0;
    registerItemEventHandler(() => {
      dispatched++;
      return Promise.resolve({ ok: true });
    });
    const env = makeEnv();
    const overDefault: ItemEventMessage = {
      kind: "item-event",
      integration_name: "demo",
      connection_id: "conn_a",
      event_type: "item.created",
      item_id: "item_y",
      cycle: {
        originating_connection_id: "conn-orig",
        hop_count: SDK_DEFAULT_HOP_BUDGET,
      },
      payload: {},
    };
    const outcome = await consumeBatch(env, [makeMsg(overDefault)]);
    expect(outcome.acked).toBe(1);
    expect(dispatched).toBe(0);
  });
});

describe("consumeBatch — DLQ failure-reason enrichment", () => {
  beforeEach(() => {
    _resetHandlers();
  });

  /** Recording stub for the `DlqProducer.send` calls. */
  function makeRecordingDlq() {
    const sent: { body: unknown; contentType: string | undefined }[] = [];
    const producer: DlqProducer = {
      send(body, opts) {
        sent.push({ body, contentType: opts?.contentType });
        return Promise.resolve();
      },
    };
    return { producer, sent };
  }

  it("stamps _failure_reason and forwards to the DLQ producer when handler returns retry:false", async () => {
    registerWebhookHandler(() =>
      Promise.resolve({
        ok: false,
        retry: false,
        reason: "missing_required_field",
      }),
    );
    const dlq = makeRecordingDlq();
    const env: ConsumerEnvironment = {
      ...makeEnv(),
      dlqProducerFor: (kind) => (kind === "webhook" ? dlq.producer : null),
    };
    const m = makeMsg(WEBHOOK());
    const outcome = await consumeBatch(env, [m]);

    expect(outcome).toEqual({ acked: 0, retried: 0, failed: 1 });
    expect(m.acked).toBe(true);
    expect(dlq.sent).toHaveLength(1);

    const entry = dlq.sent[0]!;
    expect(entry.contentType).toBe("json");
    const sentBody = entry.body as WebhookMessage & {
      _failure_reason: {
        message: string;
        class_name: string;
        attempts: number;
        failed_at: string;
      };
    };
    // Original envelope fields survive the round-trip.
    expect(sentBody.kind).toBe("webhook");
    expect(sentBody.connection_id).toBe("conn_a");
    expect(sentBody.delivery_id).toBe("d_1");
    // Failure-reason fields populated.
    expect(sentBody._failure_reason.message).toBe("missing_required_field");
    expect(sentBody._failure_reason.class_name).toBe("HandlerResult");
    expect(sentBody._failure_reason.attempts).toBe(1);
    expect(typeof sentBody._failure_reason.failed_at).toBe("string");
    expect(Number.isNaN(Date.parse(sentBody._failure_reason.failed_at))).toBe(
      false,
    );
  });

  it("captures the thrown class name when dispatch throws on a retried attempt", async () => {
    class CustomFailure extends Error {
      constructor() {
        super("upstream rejected");
        this.name = "CustomFailure";
      }
    }
    registerScheduleHandler(() => Promise.reject(new CustomFailure()));
    const dlq = makeRecordingDlq();
    const env: ConsumerEnvironment = {
      ...makeEnv(),
      dlqProducerFor: (kind) => (kind === "schedule" ? dlq.producer : null),
    };
    // attempts=2 → throw treated as permanent.
    const m = makeMsg(SCHED(), 2);
    const outcome = await consumeBatch(env, [m]);

    expect(outcome).toEqual({ acked: 0, retried: 0, failed: 1 });
    expect(m.acked).toBe(true);
    expect(dlq.sent).toHaveLength(1);

    const sentBody = dlq.sent[0]!.body as ScheduleMessage & {
      _failure_reason: {
        message: string;
        class_name: string;
        attempts: number;
      };
    };
    expect(sentBody._failure_reason.class_name).toBe("CustomFailure");
    // Bare error message — dispatch_threw prefix is stripped from the DLQ stamp
    // to avoid a double-prefix in the flattened peek string.
    expect(sentBody._failure_reason.message).toBe("upstream rejected");
    expect(sentBody._failure_reason.attempts).toBe(2);
  });

  it("falls through to ack-only when no dlqProducerFor is configured", async () => {
    registerWebhookHandler(() =>
      Promise.resolve({
        ok: false,
        retry: false,
        reason: "permanent_failure",
      }),
    );
    // No dlqProducerFor on env — wrapper should not throw, should still
    // ack the message, and the outcome counters stay the same.
    const m = makeMsg(WEBHOOK());
    const outcome = await consumeBatch(makeEnv(), [m]);

    expect(outcome).toEqual({ acked: 0, retried: 0, failed: 1 });
    expect(m.acked).toBe(true);
  });

  it("skips the DLQ send when dlqProducerFor returns null for the message kind", async () => {
    registerWebhookHandler(() =>
      Promise.resolve({ ok: false, retry: false, reason: "x" }),
    );
    const schedDlq = makeRecordingDlq();
    // Only wire a schedule-family DLQ; a webhook permanent failure must
    // not produce to the wrong DLQ.
    const env: ConsumerEnvironment = {
      ...makeEnv(),
      dlqProducerFor: (kind) =>
        kind === "schedule" ? schedDlq.producer : null,
    };
    const m = makeMsg(WEBHOOK());
    await consumeBatch(env, [m]);

    expect(schedDlq.sent).toHaveLength(0);
    expect(m.acked).toBe(true);
  });

  it("does NOT stamp on the transient-retry path", async () => {
    // `retry: true` keeps using CF's retry mechanism — the wrapper
    // calls `msg.retry()` with no DLQ forward. (Only permanent failure
    // routes through the new DLQ producer.)
    registerWebhookHandler(() =>
      Promise.resolve({ ok: false, retry: true, reason: "rate_limited" }),
    );
    const dlq = makeRecordingDlq();
    const env: ConsumerEnvironment = {
      ...makeEnv(),
      dlqProducerFor: () => dlq.producer,
    };
    const m = makeMsg(WEBHOOK());
    const outcome = await consumeBatch(env, [m]);

    expect(outcome).toEqual({ acked: 0, retried: 1, failed: 0 });
    expect(m.retried).toBe(true);
    expect(dlq.sent).toHaveLength(0);
  });

  it("swallows DLQ-send failures and still acks the original", async () => {
    // Best-effort enrichment: a producer-side failure must not block
    // the ack on the main queue.
    registerWebhookHandler(() =>
      Promise.resolve({ ok: false, retry: false, reason: "x" }),
    );
    const failingProducer: DlqProducer = {
      send() {
        return Promise.reject(new Error("dlq send failed"));
      },
    };
    const env: ConsumerEnvironment = {
      ...makeEnv(),
      dlqProducerFor: () => failingProducer,
    };
    const m = makeMsg(WEBHOOK());
    const outcome = await consumeBatch(env, [m]);
    expect(outcome).toEqual({ acked: 0, retried: 0, failed: 1 });
    expect(m.acked).toBe(true);
  });
});

describe("nextHopMetadata (SDK)", () => {
  it("starts a chain when called with no parent metadata", () => {
    const meta = nextHopMetadata(null, "conn-1");
    expect(meta.hop_count).toBe(1);
    expect(meta.originating_connection_id).toBe("conn-1");
  });

  it("propagates the originating connection through the chain", () => {
    const first = nextHopMetadata(null, "conn-1");
    const second = nextHopMetadata(first, "conn-2");
    expect(second.hop_count).toBe(2);
    expect(second.originating_connection_id).toBe("conn-1");
  });

  it("preserves origin when parent has it but current is unset", () => {
    const meta = nextHopMetadata(
      { originating_connection_id: "conn-orig", hop_count: 3 },
      "conn-current",
    );
    expect(meta.hop_count).toBe(4);
    expect(meta.originating_connection_id).toBe("conn-orig");
  });
});
