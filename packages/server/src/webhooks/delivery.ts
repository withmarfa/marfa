import { createHmac } from "node:crypto";
import { hasPermission } from "@withmarfa/shared";
import type {
  PendingWebhookDelivery,
  Storage,
  WebhookDeliveryStore,
  WebhookOwner,
} from "../storage/interface.js";
import {
  eventMatchesTypeFilter,
  wireEventName,
  type EdgeEvent,
  type ItemEvent,
} from "../pubsub.js";
import { log } from "../middleware/logger.js";
import {
  resolveLiveCredential,
  resolveLiveGrant,
  type LiveCredential,
} from "../auth/live-credential.js";
import { ItemSchema, EdgeSchema, MetadataSchema } from "../routes/_schemas.js";
import { WEBHOOK_EVENTS } from "../routes/webhooks.js";
import { frameInReach } from "./reach.js";
import { DELIVERY_FAILURE, type WebhookHttpClient } from "./outbound-http.js";
import { errorMessage } from "../error-text.js";

/** Maps pubsub event types to webhook event types. Single entry point so
 *  the wire strings (item.*, metadata.changed, edge.*) stay consistent
 *  with SSE and the `WEBHOOK_EVENTS` vocabulary. */
function toWebhookEventType(
  type: ItemEvent["type"] | EdgeEvent["type"],
): string {
  return wireEventName(type);
}

/**
 * Stripe-style webhook signature. The HMAC is computed over
 * `<timestamp>.<rawBody>` (NOT the raw body alone), and the header
 * value embeds the timestamp so the receiver can re-derive the signed
 * string and enforce a replay window. Header format:
 * `t=<unix>,v1=<hex-sha256>`.
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
export const RETRY_DELAYS = [
  1000, 5000, 25000, 125000, 625000, 3125000, 15625000,
];

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

/** Longer than the HTTP timeout, so an ordinary attempt can record its
 * outcome before a crashed worker's claim becomes eligible again. The store
 * shares this deadline with the attempt worker. */
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
 * What an attempt runs with: the store, from which each
 * attempt reads the subscription and its owner again, and the
 * address-checked client every delivery is posted with.
 */
export interface WebhookDeliveryContext {
  storage: Storage;
  http: WebhookHttpClient;
}

/** Why a pending delivery is settled unsent, as the delivery log says it. */
export const DELIVERY_CANCELED = {
  removed: "The subscription was removed.",
  inactive: "The subscription was turned off.",
  repointed: "The subscription was pointed at another URL.",
  credential:
    "The credential the subscription belongs to no longer stands or no longer holds webhooks.manage.",
  unreadable:
    "The credential the subscription belongs to may not read this event.",
} as const;

/**
 * The credential a subscription belongs to, as it stands now, where it still
 * stands and still holds `webhooks.manage`; null where the subscription is to
 * send nothing. A signed-in app's subscription is its grant's, so it is
 * answered with the grant's consented scopes whatever became of the token
 * that registered it.
 */
export async function ownerCredential(
  storage: Storage,
  owner: WebhookOwner,
): Promise<LiveCredential | null> {
  const credential =
    owner.kind === "key"
      ? await resolveLiveCredential(storage, owner.keyId, {
          tokenOutlivesExpiry: false,
        })
      : await resolveLiveGrant(storage, owner.clientId, owner.authUserId);
  if (!credential) return null;
  if (!hasPermission(credential.permissions, "webhooks.manage")) return null;
  return credential;
}

/** One name per owner, for asking each owner once per dispatch. */
function ownerName(owner: WebhookOwner): string {
  return owner.kind === "key"
    ? `key ${owner.keyId}`
    : `grant ${owner.clientId} ${owner.authUserId}`;
}

/**
 * The body a pending delivery may be sent with now, and the secret to sign
 * it under, or why it is to be settled unsent.
 *
 * Asked at every attempt rather than once at scheduling, because a retry
 * runs long after the event: the subscription may since have been removed,
 * turned off or pointed elsewhere, and its credential revoked or narrowed.
 */
export async function deliveryInReach(
  storage: Storage,
  delivery: PendingWebhookDelivery,
): Promise<{ body: string; secret: string } | { cancel: string }> {
  const subscription = await storage.outboundWebhooks.get(delivery.webhook_id);
  if (!subscription) return { cancel: DELIVERY_CANCELED.removed };
  if (!subscription.active) return { cancel: DELIVERY_CANCELED.inactive };
  if (subscription.url !== delivery.webhook_url) {
    return { cancel: DELIVERY_CANCELED.repointed };
  }
  const credential = await ownerCredential(storage, subscription.owner);
  if (!credential) return { cancel: DELIVERY_CANCELED.credential };
  let stored: unknown;
  try {
    stored = JSON.parse(delivery.payload);
  } catch {
    return { cancel: DELIVERY_CANCELED.unreadable };
  }
  if (typeof stored !== "object" || stored === null) {
    return { cancel: DELIVERY_CANCELED.unreadable };
  }
  const frame = frameInReach(credential.key, stored as Record<string, unknown>);
  if (!frame) return { cancel: DELIVERY_CANCELED.unreadable };
  // Deleted so the spread below cannot keep the frame's `event_type` first:
  // the body's `event_type` follows the frame's own fields.
  delete frame.event_type;
  const body = JSON.stringify({
    ...frame,
    event_type: delivery.event_type,
    event_id: delivery.event_id,
    delivery_id: delivery.id,
    ...("item" in frame && { metadata: frame.metadata ?? null }),
    delivered_at: new Date().toISOString(),
  });
  return { body, secret: subscription.secret };
}

export async function deliverWebhookAttempt(
  context: WebhookDeliveryContext,
  delivery: PendingWebhookDelivery,
): Promise<void> {
  const store = context.storage.outboundWebhookDeliveries;
  const nextAttempt = delivery.attempt + 1;
  const logged = {
    delivery_id: delivery.id,
    webhook_id: delivery.webhook_id,
    event_type: delivery.event_type,
  };

  try {
    const prepared = await deliveryInReach(context.storage, delivery);
    if ("cancel" in prepared) {
      if (
        !(await store.markCanceled(
          delivery.id,
          delivery.claim_token,
          prepared.cancel,
        ))
      )
        return;
      log("info", "Webhook delivery canceled", {
        ...logged,
        reason: prepared.cancel,
      });
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const outcome = await context.http.post({
      url: delivery.webhook_url,
      headers: {
        "Content-Type": "application/json",
        "X-Marfa-Signature": buildSignatureHeader(
          timestamp,
          prepared.body,
          prepared.secret,
        ),
        "X-Marfa-Event-Type": delivery.event_type,
      },
      body: prepared.body,
      timeoutMs: POLLER_TIMEOUT_MS,
    });

    if (outcome.kind === "failed") {
      await scheduleDeliveryRetry(
        store,
        delivery,
        nextAttempt,
        undefined,
        outcome.error,
        undefined,
      );
      return;
    }

    if (outcome.kind === "redirected") {
      if (
        !(await store.markFailed(
          delivery.id,
          delivery.claim_token,
          outcome.status,
          DELIVERY_FAILURE.redirect,
          nextAttempt,
          null,
        ))
      )
        return;
      log("error", "Webhook dead-lettered", {
        ...logged,
        status: outcome.status,
        attempt: nextAttempt,
      });
      return;
    }

    if (outcome.status >= 200 && outcome.status < 300) {
      if (
        !(await store.markSuccess(
          delivery.id,
          delivery.claim_token,
          outcome.status,
          nextAttempt,
        ))
      )
        return;
      log("info", "Webhook delivered", {
        ...logged,
        status: outcome.status,
        attempt: nextAttempt,
      });
      return;
    }

    if (
      outcome.status >= 400 &&
      outcome.status < 500 &&
      !RETRYABLE_4XX.has(outcome.status)
    ) {
      if (
        !(await store.markFailed(
          delivery.id,
          delivery.claim_token,
          outcome.status,
          `HTTP ${String(outcome.status)}`,
          nextAttempt,
          null,
        ))
      )
        return;
      log("error", "Webhook dead-lettered", {
        ...logged,
        status: outcome.status,
        attempt: nextAttempt,
      });
      return;
    }

    const retryAfterMs = parseRetryAfter(outcome.retryAfter);
    await scheduleDeliveryRetry(
      store,
      delivery,
      nextAttempt,
      outcome.status,
      undefined,
      retryAfterMs ?? undefined,
    );
  } catch (err) {
    log("error", "Webhook attempt failed", {
      ...logged,
      error: errorMessage(err),
    });
  }
}

async function scheduleDeliveryRetry(
  store: WebhookDeliveryStore,
  delivery: PendingWebhookDelivery,
  attempt: number,
  statusCode: number | undefined,
  error: string | undefined,
  overrideDelayMs: number | undefined,
): Promise<void> {
  if (attempt >= delivery.retry_start_attempt + 8) {
    if (
      !(await store.markFailed(
        delivery.id,
        delivery.claim_token,
        statusCode,
        error ?? "Max attempts reached",
        attempt,
        null,
      ))
    )
      return;
    log("error", "Webhook max attempts reached", {
      delivery_id: delivery.id,
      webhook_id: delivery.webhook_id,
      event_type: delivery.event_type,
      status: statusCode ?? null,
      attempt,
      error: error ?? null,
    });
    return;
  }

  const ordinaryDelay =
    RETRY_DELAYS[attempt - delivery.retry_start_attempt - 1];
  if (ordinaryDelay === undefined)
    throw new Error("Invalid webhook retry position");
  const delayMs = Math.max(overrideDelayMs ?? 0, ordinaryDelay);
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  if (
    !(await store.markFailed(
      delivery.id,
      delivery.claim_token,
      statusCode,
      error ?? `HTTP ${String(statusCode)}`,
      attempt,
      nextAttemptAt,
    ))
  )
    return;
  log("info", "Webhook retry scheduled", {
    delivery_id: delivery.id,
    webhook_id: delivery.webhook_id,
    event_type: delivery.event_type,
    status: statusCode ?? null,
    attempt,
    next_attempt_at: nextAttemptAt,
  });
}

export function validWebhookFrame(
  frame: Record<string, unknown>,
  eventType: string,
): boolean {
  const isEdge = eventType.startsWith("edge.");
  const shapeValid = isEdge
    ? !("item" in frame) &&
      EdgeSchema.safeParse(frame.edge).success &&
      (frame.source_type === undefined || typeof frame.source_type === "string")
    : !("edge" in frame) &&
      ItemSchema.safeParse(frame.item).success &&
      ((frame.metadata === undefined && eventType !== "metadata.changed") ||
        MetadataSchema.safeParse(frame.metadata).success);
  return (
    WEBHOOK_EVENTS.some((known) => known === eventType) &&
    frame.event_type === eventType &&
    shapeValid
  );
}

export interface WebhookSchedulingContext {
  storage: Storage;
  wakePoller: () => Promise<void>;
}

export class WebhookScheduler {
  constructor(private context: WebhookSchedulingContext) {}

  /** Consecutive events within aggregate scan, subscription and copy budgets. */
  async runOnce(): Promise<{
    examined: number;
    scheduled: number;
    fetched: number;
    scannedBytes: number;
    queuedBytes: number;
    cursor: string;
    event: string | null;
  }> {
    const { storage } = this.context;
    const result = await storage.runInTransaction(async () => {
      const position = await storage.outboundWebhooks.checkpoint();
      const head = (await storage.eventLog.getMaxId()) ?? 0n;
      const minimum = await storage.eventLog.getMinRetainedId();
      if (
        position.lastEventId > head ||
        (position.eventId !== null && position.eventId > head)
      ) {
        throw new Error(
          "Outbound webhook checkpoint is ahead of the event log",
        );
      }
      if (minimum !== null && minimum > position.lastEventId + 1n) {
        throw new Error(
          "Outbound webhook scheduling fell behind event retention",
        );
      }
      let scheduled = 0;
      let examined = 0;
      let fetched = 0;
      let considered = 0;
      let scannedBytes = 0;
      let queuedBytes = 0;
      const byteTarget = 8 * 1024 * 1024;
      const credentials = new Map<string, Promise<LiveCredential | null>>();
      while (fetched < 128 && examined < 50 && scheduled < 50) {
        const [event] = await storage.eventLog.getAfter(
          position.lastEventId,
          1,
        );
        if (!event) {
          if (position.eventId !== null)
            throw new Error("Outbound webhook in-progress event is missing");
          break;
        }
        fetched++;
        const payloadBytes = Buffer.byteLength(event.payload, "utf8");
        // Measure one candidate at a time. A valid oversized first event must
        // progress; otherwise leave the candidate unacknowledged for next tick.
        if (considered > 0 && scannedBytes + payloadBytes > byteTarget) break;
        scannedBytes += payloadBytes;
        considered++;
        if (
          event.id !== position.lastEventId + 1n ||
          event.id > head ||
          (position.eventId !== null && position.eventId !== event.id)
        ) {
          throw new Error("Outbound webhook event log is inconsistent");
        }
        position.eventId = event.id;
        let stored: unknown;
        try {
          stored = JSON.parse(event.payload);
        } catch {
          throw new Error("Outbound webhook event payload cannot be read");
        }
        if (typeof stored !== "object" || stored === null) {
          throw new Error("Outbound webhook event payload is not a frame");
        }
        const frame = stored as Record<string, unknown>;
        const eventType = toWebhookEventType(
          event.event_type as ItemEvent["type"] | EdgeEvent["type"],
        );
        // Validate the retained frame independently of subscription matching
        // and authorization: malformed history is a failed job, not a skip.
        const isEdge = eventType.startsWith("edge.");
        if (!validWebhookFrame(frame, eventType))
          throw new Error("Outbound webhook event payload is inconsistent");
        let complete = !event.enable_fanout;
        if (event.enable_fanout) {
          const pageLimit = 50 - examined;
          const subscriptions = await storage.outboundWebhooks.listAfter(
            position.afterSubscriptionId,
            pageLimit,
            { eventId: event.id, headId: head },
          );
          let pageExamined = 0;
          for (const subscription of subscriptions) {
            if (subscription.event_start_id > head) {
              throw new Error(
                "Outbound webhook subscription starts ahead of the event log",
              );
            }
            let eligible =
              subscription.active &&
              event.id > subscription.event_start_id &&
              subscription.events.includes(eventType);
            if (eligible && !isEdge && subscription.type_filter) {
              const item = frame.item;
              eligible =
                typeof item === "object" &&
                item !== null &&
                "type" in item &&
                typeof item.type === "string" &&
                eventMatchesTypeFilter(item.type, subscription.type_filter);
            }
            if (eligible) {
              const name = ownerName(subscription.owner);
              let credential = credentials.get(name);
              if (!credential) {
                credential = ownerCredential(storage, subscription.owner);
                credentials.set(name, credential);
              }
              const standing = await credential;
              eligible =
                standing !== null && frameInReach(standing.key, frame) !== null;
            }
            if (eligible) {
              // Allow one valid oversized payload; never reject accepted work.
              // A row stopped here is not examined/acknowledged until next pass.
              if (scheduled > 0 && queuedBytes + payloadBytes > byteTarget)
                break;
              await storage.outboundWebhookDeliveries.schedule({
                webhookId: subscription.id,
                eventId: event.id,
                eventType,
                payload: event.payload,
                webhookUrl: subscription.url,
                nextAttemptAt: new Date().toISOString(),
              });
              scheduled++;
              queuedBytes += payloadBytes;
            }
            examined++;
            pageExamined++;
            position.afterSubscriptionId = subscription.id;
            if (queuedBytes >= byteTarget || scheduled >= 50) break;
          }
          // Exactly full pages retain partial state until a bounded next read
          // proves exhaustion. An early byte stop also retains the position.
          complete =
            subscriptions.length < pageLimit &&
            pageExamined === subscriptions.length;
        }
        if (complete) {
          position.lastEventId = event.id;
          position.eventId = null;
          position.afterSubscriptionId = null;
        }
        if (
          !complete ||
          scannedBytes >= byteTarget ||
          queuedBytes >= byteTarget
        )
          break;
      }
      if (considered > 0) await storage.outboundWebhooks.acknowledge(position);
      return {
        scheduled,
        examined,
        fetched,
        scannedBytes,
        queuedBytes,
        cursor: position.lastEventId.toString(),
        event: position.eventId?.toString() ?? null,
      };
    });
    if (result.scheduled > 0) await this.context.wakePoller();
    return result;
  }
}

// ---------------------------------------------------------------------------
// WebhookPoller — picks up pending deliveries from the database and attempts
// HTTP delivery with durable retry. Survives server restarts: the
// housekeeping scheduler runs it on the cadence below.
// ---------------------------------------------------------------------------

export const WEBHOOK_POLL_INTERVAL_MS = 30_000;
export const WEBHOOK_POLL_BATCH_SIZE = 50;

export class WebhookPoller {
  constructor(private context: WebhookDeliveryContext) {}

  /** A failure to read the queue is the scheduler's to classify. */
  async runOnce(): Promise<{ attempted: number }> {
    const pending =
      await this.context.storage.outboundWebhookDeliveries.getPending(
        new Date().toISOString(),
        WEBHOOK_POLL_BATCH_SIZE,
      );
    await Promise.allSettled(
      pending.map((d) => deliverWebhookAttempt(this.context, d)),
    );
    return { attempted: pending.length };
  }
}
