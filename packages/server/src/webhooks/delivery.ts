import { createHmac } from "node:crypto";
import { matchesTypePattern } from "@myme/shared";
import type { Webhook } from "@myme/shared";
import type {
  WebhookStore,
  WebhookDeliveryStore,
} from "../storage/interface.js";
import { subscribe } from "../graphql/pubsub.js";
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
        console.error("Webhook consumer error:", err);
      }
    }
  }

  private async dispatch(event: ItemEvent): Promise<void> {
    let webhooks: Webhook[];
    try {
      webhooks = await this.webhookStore.listActive();
    } catch (err) {
      console.error("Failed to load active webhooks:", err);
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

    await Promise.allSettled(
      matching.map((w) => this.deliverToWebhook(w, payload, eventName)),
    );
  }

  private async deliverToWebhook(
    webhook: Webhook,
    payload: string,
    eventName: string,
  ): Promise<void> {
    const signature = sign(payload, webhook.secret);

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
        }, 10_000);

        const response = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Myme-Signature": signature,
            "X-Myme-Event": eventName,
          },
          body: payload,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          await this.logDelivery(
            webhook.id,
            eventName,
            response.status,
            attempt + 1,
            true,
          );
          return;
        }

        // Don't retry client errors (4xx) — they won't succeed on retry
        if (response.status >= 400 && response.status < 500) {
          await this.logDelivery(
            webhook.id,
            eventName,
            response.status,
            attempt + 1,
            false,
          );
          return;
        }

        // Server error — log and fall through to retry
        await this.logDelivery(
          webhook.id,
          eventName,
          response.status,
          attempt + 1,
          false,
        );
        if (attempt < RETRY_DELAYS.length) {
          await this.delay(RETRY_DELAYS[attempt] ?? 1000);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.logDelivery(
          webhook.id,
          eventName,
          undefined,
          attempt + 1,
          false,
          errMsg,
        );
        // Network error or timeout — retry if attempts remain
        if (attempt >= RETRY_DELAYS.length) {
          console.error(
            `Webhook ${webhook.id} delivery failed after ${String(RETRY_DELAYS.length + 1)} attempts: ${webhook.url}`,
          );
        } else {
          await this.delay(RETRY_DELAYS[attempt] ?? 1000);
        }
      }
    }
  }

  private async logDelivery(
    webhookId: string,
    event: string,
    statusCode: number | undefined,
    attempt: number,
    success: boolean,
    error?: string,
  ): Promise<void> {
    try {
      await this.deliveryStore.log({
        webhookId,
        event,
        statusCode,
        attempt,
        success,
        error,
      });
    } catch (err) {
      console.error("Failed to log webhook delivery:", err);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
