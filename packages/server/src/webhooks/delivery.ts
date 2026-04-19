import { createHmac } from "node:crypto";
import { matchesTypePattern } from "@mymehq/shared";
import type { Webhook } from "@mymehq/shared";
import type {
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
 * Returns the full header value. Callers set it as `X-Myme-Signature`.
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

/** Maximum delay we'll honour from a Retry-After header. Prevents a
 *  malicious or buggy receiver from pinning a worker indefinitely. */
const RETRY_AFTER_CEILING_MS = 5 * 60 * 1000;

/** 4xx status codes that mean "try again later" rather than "give up".
 *  Everything else in the 4xx range is treated as a permanent client
 *  error and dead-lettered. */
const RETRYABLE_4XX = new Set([408, 429]);

/** Parse a Retry-After header value. Supports both delta-seconds (RFC
 *  9110 §10.2.3) and HTTP-date forms. Returns milliseconds, clamped to
 *  RETRY_AFTER_CEILING_MS. Returns null on parse failure or zero/negative
 *  values, signalling fall-through to the default backoff schedule.
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
    await Promise.allSettled(
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
    await Promise.allSettled(
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
          }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// WebhookPoller — picks up pending deliveries from the database and attempts
// HTTP delivery with durable retry. Survives server restarts.
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
      await Promise.allSettled(pending.map((d) => this.attempt(d)));
    } catch (err) {
      log("error", "Webhook poller error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async attempt(delivery: PendingDelivery): Promise<void> {
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
      }, 10_000);

      const response = await fetch(delivery.webhook_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Myme-Signature": signature,
          "X-Myme-Event": delivery.event,
        },
        body: delivery.payload,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        await this.deliveryStore.markSuccess(
          delivery.id,
          response.status,
          nextAttempt,
        );
        return;
      }

      // 4xx: dead-letter unless it's a "try again later" code (408, 429).
      // 408 and 429 fall through to scheduleRetry; 429 also honours the
      // server's Retry-After hint.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        !RETRYABLE_4XX.has(response.status)
      ) {
        await this.deliveryStore.markDeadLetter(delivery.id);
        return;
      }

      // Retryable: 408, 429, all 5xx. Honour Retry-After when present
      // (RFC 9110 §10.2.3); otherwise fall back to RETRY_DELAYS.
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      await this.scheduleRetry(
        delivery,
        nextAttempt,
        response.status,
        undefined,
        retryAfterMs ?? undefined,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.scheduleRetry(delivery, nextAttempt, undefined, errMsg);
    }
  }

  private async scheduleRetry(
    delivery: PendingDelivery,
    attempt: number,
    statusCode: number | undefined,
    error?: string,
    overrideDelayMs?: number,
  ): Promise<void> {
    if (attempt >= delivery.max_attempts) {
      await this.deliveryStore.markFailed(
        delivery.id,
        statusCode,
        error ?? "Max attempts reached",
        attempt,
        null,
      );
      return;
    }

    const delayMs = overrideDelayMs ?? RETRY_DELAYS[attempt - 1] ?? 25000;
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    await this.deliveryStore.markFailed(
      delivery.id,
      statusCode,
      error ?? `HTTP ${String(statusCode)}`,
      attempt,
      nextAttemptAt,
    );
  }
}
