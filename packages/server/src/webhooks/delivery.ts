import { createHmac } from "node:crypto";
import { matchesTypePattern } from "@mymehq/shared";
import type { Webhook } from "@mymehq/shared";
import type {
  WebhookStore,
  WebhookDeliveryStore,
} from "../storage/interface.js";
import { subscribe } from "../graphql/pubsub.js";
import { log } from "../middleware/logger.js";
import type { ItemEvent } from "../graphql/pubsub.js";

/** Maps pubsub event types to webhook event names. */
function toWebhookEvent(type: ItemEvent["type"]): string {
  return `item.${type}`;
}

/** Signs a payload with HMAC-SHA256 using the webhook secret. */
function sign(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

/** Retry delays in milliseconds. */
const RETRY_DELAYS = [1000, 5000, 25000];

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
    try {
      for await (const event of subscribe()) {
        if (!this.running) break;
        // Fire-and-forget delivery — don't block the event loop
        void this.dispatch(event);
      }
    } catch (err) {
      // AbortError on shutdown is expected
      if (this.running) {
        log("error", "Webhook consumer error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
    const signature = sign(delivery.payload, delivery.webhook_secret);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

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

      // 4xx: don't retry, mark as dead letter
      if (response.status >= 400 && response.status < 500) {
        await this.deliveryStore.markDeadLetter(delivery.id);
        return;
      }

      // 5xx: retry if attempts remain
      await this.scheduleRetry(delivery, nextAttempt, response.status);
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

    const delayMs = RETRY_DELAYS[attempt - 1] ?? 25000;
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    await this.deliveryStore.markFailed(
      delivery.id,
      statusCode,
      error ?? `HTTP ${statusCode}`,
      attempt,
      nextAttemptAt,
    );
  }
}
