import { createHmac } from "node:crypto";
import { matchesTypePattern } from "@withmarfa/shared";
import type { Webhook } from "@withmarfa/shared";
import type {
  PendingWebhookDelivery,
  WebhookStore,
  WebhookDeliveryStore,
} from "../storage/interface.js";
import {
  subscribe,
  subscribeEdges,
  wireEventName,
  type EdgeEvent,
  type ItemEvent,
} from "../pubsub.js";
import { log } from "../middleware/logger.js";

/** Maps pubsub event types to webhook event names. Single entry point so
 *  the wire strings (item.*, metadata.changed, edge.*) stay consistent
 *  with SSE and the webhook VALID_EVENTS set. */
function toWebhookEvent(type: ItemEvent["type"] | EdgeEvent["type"]): string {
  return wireEventName(type);
}

/**
 * Stripe-style webhook signature. The HMAC is computed over
 * `<timestamp>.<rawBody>` (NOT the raw body alone), and the header
 * value embeds the timestamp so the receiver can re-derive the signed
 * string and enforce a replay window. Matches the documented contract
 * in docs/api/webhooks.mdx. Header format: `t=<unix>,v1=<hex-sha256>`.
 *
 * Returns the full header value. Callers set it as `X-Marfa-Signature`.
 */
export function buildSignatureHeader(
  timestamp: string,
  rawBody: string,
  secret: string,
): string {
  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

/** Retry delays in milliseconds. */
const RETRY_DELAYS = [1000, 5000, 25000];

/** Maximum delay we'll honor from a Retry-After header. Prevents a
 *  malicious or buggy receiver from pinning a worker indefinitely. */
const RETRY_AFTER_CEILING_MS = 5 * 60 * 1000;

/** 4xx status codes that mean "try again later" rather than "give up".
 *  Everything else in the 4xx range is treated as a permanent client
 *  error and dead-lettered. */
const RETRYABLE_4XX = new Set([408, 429]);

/** HTTP timeout for the background poller. Generous so a slow receiver
 *  doesn't cascade into retry churn. */
const POLLER_TIMEOUT_MS = 10_000;

/** HTTP timeout for the best-effort direct-dispatch fast path. Kept
 *  short so a slow receiver cannot stall the event handler's task; if
 *  this deadline is missed, the row stays claimed only until the claim
 *  TTL expires, and the 30-second poller catches it on its next tick. */
const DIRECT_DISPATCH_TIMEOUT_MS = 5_000;

/**
 * How long a claimed `outbound_webhook_deliveries` row is hidden from the
 * eligibility window. Set generously so a single instance's full HTTP
 * attempt (≤ 10s poller timeout) finishes and writes its outcome before
 * the row becomes visible again; short enough that a crashed worker
 * doesn't stall a delivery indefinitely. Single source of truth — both
 * store implementations import this value from here so the poller and
 * the direct-dispatcher can never disagree on the reclaim deadline.
 */
export const CLAIM_LOCK_TTL_MS = 60_000;

/** Parse a Retry-After header value. Supports both delta-seconds (RFC
 *  9110 §10.2.3) and HTTP-date forms. Returns milliseconds, clamped to
 *  RETRY_AFTER_CEILING_MS. Returns null on parse failure or zero/negative
 *  values, signaling fall-through to the default backoff schedule.
 *  Exported for testing. */
export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  // Delta-seconds form: integer number of seconds
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.ceil(seconds * 1000), RETRY_AFTER_CEILING_MS);
  }

  // HTTP-date form
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, RETRY_AFTER_CEILING_MS);
  }

  return null;
}

/**
 * Shared HTTP-attempt logic used by both the 30-second poller and the
 * best-effort direct-dispatch fast path. Signs, posts, and updates the
 * delivery row via `markSuccess` / `markDeadLetter` / `markFailed`. Never
 * throws — all errors are logged and written to the store. The `direct`
 * flag only influences log tagging so operators can distinguish the two
 * paths; the state transitions are identical.
 */
export async function deliverWebhookAttempt(
  store: WebhookDeliveryStore,
  delivery: PendingWebhookDelivery,
  timeoutMs: number,
  direct: boolean,
): Promise<void> {
  const nextAttempt = delivery.attempt + 1;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildSignatureHeader(
    timestamp,
    delivery.payload,
    delivery.webhook_secret,
  );

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const response = await fetch(delivery.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Marfa-Signature": signature,
        "X-Marfa-Event": delivery.event,
      },
      body: delivery.payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      await store.markSuccess(delivery.id, response.status, nextAttempt);
      log("info", "Webhook delivered", {
        delivery_id: delivery.id,
        webhook_id: delivery.webhook_id,
        event: delivery.event,
        status: response.status,
        attempt: nextAttempt,
        direct,
      });
      return;
    }

    if (
      response.status >= 400 &&
      response.status < 500 &&
      !RETRYABLE_4XX.has(response.status)
    ) {
      await store.markDeadLetter(delivery.id);
      log("error", "Webhook dead-lettered", {
        delivery_id: delivery.id,
        webhook_id: delivery.webhook_id,
        event: delivery.event,
        status: response.status,
        attempt: nextAttempt,
        direct,
      });
      return;
    }

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    await scheduleDeliveryRetry(
      store,
      delivery,
      nextAttempt,
      response.status,
      undefined,
      retryAfterMs ?? undefined,
      direct,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await scheduleDeliveryRetry(
      store,
      delivery,
      nextAttempt,
      undefined,
      errMsg,
      undefined,
      direct,
    );
  }
}

async function scheduleDeliveryRetry(
  store: WebhookDeliveryStore,
  delivery: PendingWebhookDelivery,
  attempt: number,
  statusCode: number | undefined,
  error: string | undefined,
  overrideDelayMs: number | undefined,
  direct: boolean,
): Promise<void> {
  if (attempt >= delivery.max_attempts) {
    await store.markFailed(
      delivery.id,
      statusCode,
      error ?? "Max attempts reached",
      attempt,
      null,
    );
    log("error", "Webhook max attempts reached", {
      delivery_id: delivery.id,
      webhook_id: delivery.webhook_id,
      event: delivery.event,
      status: statusCode ?? null,
      attempt,
      error: error ?? null,
      direct,
    });
    return;
  }

  const delayMs = overrideDelayMs ?? RETRY_DELAYS[attempt - 1] ?? 25000;
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  await store.markFailed(
    delivery.id,
    statusCode,
    error ?? `HTTP ${String(statusCode)}`,
    attempt,
    nextAttemptAt,
  );
  log("info", "Webhook retry scheduled", {
    delivery_id: delivery.id,
    webhook_id: delivery.webhook_id,
    event: delivery.event,
    status: statusCode ?? null,
    attempt,
    next_attempt_at: nextAttemptAt,
    direct,
  });
}

export class WebhookConsumer {
  private running = false;
  private abortController: AbortController | null = null;

  constructor(
    private webhookStore: WebhookStore,
    private deliveryStore: WebhookDeliveryStore,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    void this.consume();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async consume(): Promise<void> {
    const itemLoop = (async () => {
      try {
        for await (const event of subscribe()) {
          if (!this.running) break;
          void this.dispatch(event);
        }
      } catch (err) {
        if (this.running) {
          log("error", "Webhook item consumer error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    const edgeLoop = (async () => {
      try {
        for await (const event of subscribeEdges()) {
          if (!this.running) break;
          void this.dispatchEdge(event);
        }
      } catch (err) {
        if (this.running) {
          log("error", "Webhook edge consumer error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    await Promise.allSettled([itemLoop, edgeLoop]);
  }

  private async dispatchEdge(event: EdgeEvent): Promise<void> {
    let webhooks: Webhook[];
    try {
      webhooks = await this.webhookStore.listActive();
    } catch (err) {
      log("error", "Failed to load active webhooks", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const eventName = toWebhookEvent(event.type);
    const matching = webhooks.filter((w) => {
      if (!w.events.includes(eventName)) return false;
      if (w.tenant_id && event.tenantId && w.tenant_id !== event.tenantId)
        return false;
      // Edge events don't carry an item type; any type_filter skips them.
      if (w.type_filter) return false;
      return true;
    });
    if (matching.length === 0) return;
    const payload = JSON.stringify({
      event: eventName,
      edge: event.edge,
      delivered_at: new Date().toISOString(),
    });
    const results = await Promise.allSettled(
      matching.map((w) =>
        this.deliveryStore.schedule({
          webhookId: w.id,
          event: eventName,
          payload,
          webhookUrl: w.url,
          webhookSecret: w.secret,
          nextAttemptAt: new Date().toISOString(),
        }),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled") void this.tryDirectDispatch(r.value);
    }
  }

  private async dispatch(event: ItemEvent): Promise<void> {
    let webhooks: Webhook[];
    try {
      webhooks = await this.webhookStore.listActive();
    } catch (err) {
      log("error", "Failed to load active webhooks", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const eventName = toWebhookEvent(event.type);

    const matching = webhooks.filter((w) => {
      // Must subscribe to this event type
      if (!w.events.includes(eventName)) return false;
      // Tenant isolation — only deliver to webhooks matching the event's tenant
      if (w.tenant_id && event.tenantId && w.tenant_id !== event.tenantId)
        return false;
      // Type filter — if the webhook has a type_filter, the item type must match
      if (
        w.type_filter &&
        !matchesTypePattern(event.item.type, [w.type_filter])
      )
        return false;
      return true;
    });

    if (matching.length === 0) return;

    const payload = JSON.stringify({
      event: eventName,
      item: event.item,
      metadata: event.metadata ?? null,
      delivered_at: new Date().toISOString(),
    });

    // Schedule deliveries in the database for durable retry
    const results = await Promise.allSettled(
      matching.map((w) =>
        this.deliveryStore
          .schedule({
            webhookId: w.id,
            event: eventName,
            payload,
            webhookUrl: w.url,
            webhookSecret: w.secret,
            nextAttemptAt: new Date().toISOString(),
          })
          .catch((err: unknown) => {
            log("error", "Failed to schedule webhook delivery", {
              webhook_id: w.id,
              error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
          }),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && typeof r.value === "string") {
        void this.tryDirectDispatch(r.value);
      }
    }
  }

  /**
   * Best-effort direct HTTP dispatch for a just-scheduled delivery.
   * Atomically claims the row via `claimById` (CAS guarded by
   * `status = 'pending'` and `next_attempt_at <= now`). If the claim
   * fails — e.g. the poller raced us to it — returns silently; the other
   * worker is already responsible. If the claim succeeds, the HTTP
   * attempt runs with a shorter timeout than the poller; outcomes go
   * through the same `markSuccess` / `markFailed` / `markDeadLetter`
   * state transitions, so on a network error / 5xx the poller picks the
   * row up on its next tick exactly as it would today.
   *
   * Fire-and-forget from the caller's perspective; all errors are logged
   * by `deliverWebhookAttempt`.
   */
  private async tryDirectDispatch(deliveryId: string): Promise<void> {
    try {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const claimExpiry = new Date(nowMs + CLAIM_LOCK_TTL_MS).toISOString();
      const claimed = await this.deliveryStore.claimById(
        deliveryId,
        claimExpiry,
        now,
      );
      if (!claimed) return;
      await deliverWebhookAttempt(
        this.deliveryStore,
        claimed,
        DIRECT_DISPATCH_TIMEOUT_MS,
        true,
      );
    } catch (err) {
      log("error", "Direct webhook dispatch failed", {
        delivery_id: deliveryId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// WebhookPoller — picks up pending deliveries from the database and attempts
// HTTP delivery with durable retry. Survives server restarts.
// ---------------------------------------------------------------------------

export class WebhookPoller {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private deliveryStore: WebhookDeliveryStore) {}

  start(): void {
    // Poll every 30 seconds for pending deliveries
    this.interval = setInterval(() => void this.poll(), 30_000);
    // Also poll immediately on start to pick up any pending from before restart
    void this.poll();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const pending = await this.deliveryStore.getPending(
        new Date().toISOString(),
        50,
      );
      await Promise.allSettled(
        pending.map((d) =>
          deliverWebhookAttempt(
            this.deliveryStore,
            d,
            POLLER_TIMEOUT_MS,
            false,
          ),
        ),
      );
    } catch (err) {
      log("error", "Webhook poller error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
