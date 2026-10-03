import { createHmac } from "node:crypto";
import { hasPermission, matchesTypePattern } from "@withmarfa/shared";
import type {
  PendingWebhookDelivery,
  Storage,
  WebhookDeliveryStore,
  WebhookOwner,
} from "../storage/interface.js";
import { wireEventName, type EdgeEvent, type ItemEvent } from "../pubsub.js";
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
 *  TTL expires, and the 30-second poller catches it on its next run. */
const DIRECT_DISPATCH_TIMEOUT_MS = 5_000;

/**
 * How long a claimed `outbound_webhook_deliveries` row is hidden from the
 * eligibility window. Set generously so a single instance's full HTTP
 * attempt (≤ 10s poller timeout) finishes and writes its outcome before
 * the row becomes visible again; short enough that a crashed worker
 * doesn't stall a delivery indefinitely. Single source of truth — the
 * store imports this value from here so the poller and the
 * direct-dispatcher can never disagree on the reclaim deadline.
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
 * What the consumer and the poller send through: the store, from which each
 * attempt reads the subscription and its owner again, and the
 * address-checked client every delivery is posted with.
 */
export interface WebhookDeliveryContext {
  storage: Storage;
  http: WebhookHttpClient;
}

/** Why a pending delivery is settled unsent, as the delivery log says it. */
export const DELIVERY_CANCELLED = {
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
async function ownerCredential(
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
  if (!subscription) return { cancel: DELIVERY_CANCELLED.removed };
  if (!subscription.active) return { cancel: DELIVERY_CANCELLED.inactive };
  if (subscription.url !== delivery.webhook_url) {
    return { cancel: DELIVERY_CANCELLED.repointed };
  }
  const credential = await ownerCredential(storage, subscription.owner);
  if (!credential) return { cancel: DELIVERY_CANCELLED.credential };
  let stored: unknown;
  try {
    stored = JSON.parse(delivery.payload);
  } catch {
    return { cancel: DELIVERY_CANCELLED.unreadable };
  }
  if (typeof stored !== "object" || stored === null) {
    return { cancel: DELIVERY_CANCELLED.unreadable };
  }
  const frame = await frameInReach(
    storage,
    credential.key,
    stored as Record<string, unknown>,
  );
  if (!frame) return { cancel: DELIVERY_CANCELLED.unreadable };
  delete frame.type;
  const body = JSON.stringify({
    event_type: delivery.event_type,
    ...frame,
    ...("item" in frame && { metadata: frame.metadata ?? null }),
    delivered_at: new Date().toISOString(),
  });
  return { body, secret: subscription.secret };
}

/**
 * Shared HTTP-attempt logic used by both the 30-second poller and the
 * best-effort direct-dispatch fast path, and the only place a delivery is
 * sent. Narrows it to the subscription's credential, signs, posts through
 * the address-checked client, and updates the delivery row. Never throws:
 * all errors are logged and written to the store. The `direct` flag only
 * influences log tagging so operators can distinguish the two paths; the
 * state transitions are identical.
 */
export async function deliverWebhookAttempt(
  context: WebhookDeliveryContext,
  delivery: PendingWebhookDelivery,
  timeoutMs: number,
  direct: boolean,
): Promise<void> {
  const store = context.storage.outboundWebhookDeliveries;
  const nextAttempt = delivery.attempt + 1;
  const logged = {
    delivery_id: delivery.id,
    webhook_id: delivery.webhook_id,
    event_type: delivery.event_type,
    direct,
  };

  try {
    const prepared = await deliveryInReach(context.storage, delivery);
    if ("cancel" in prepared) {
      await store.markCancelled(delivery.id, prepared.cancel);
      log("info", "Webhook delivery cancelled", {
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
      timeoutMs,
    });

    if (outcome.kind === "failed") {
      await scheduleDeliveryRetry(
        store,
        delivery,
        nextAttempt,
        undefined,
        outcome.error,
        undefined,
        direct,
      );
      return;
    }

    if (outcome.kind === "redirected") {
      await store.markFailed(
        delivery.id,
        outcome.status,
        DELIVERY_FAILURE.redirect,
        nextAttempt,
        null,
      );
      log("error", "Webhook dead-lettered", {
        ...logged,
        status: outcome.status,
        attempt: nextAttempt,
      });
      return;
    }

    if (outcome.status >= 200 && outcome.status < 300) {
      await store.markSuccess(delivery.id, outcome.status, nextAttempt);
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
      await store.markDeadLetter(delivery.id);
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
      direct,
    );
  } catch (err) {
    log("error", "Webhook attempt failed", {
      ...logged,
      error: err instanceof Error ? err.message : String(err),
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
      event_type: delivery.event_type,
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
    event_type: delivery.event_type,
    status: statusCode ?? null,
    attempt,
    next_attempt_at: nextAttemptAt,
    direct,
  });
}

export class WebhookScheduler {
  constructor(private context: WebhookDeliveryContext) {}

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
      const ids: string[] = [];
      let examined = 0;
      let fetched = 0;
      let considered = 0;
      let scannedBytes = 0;
      let queuedBytes = 0;
      const byteTarget = 8 * 1024 * 1024;
      const credentials = new Map<string, Promise<LiveCredential | null>>();
      while (fetched < 128 && examined < 50 && ids.length < 50) {
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
        const shapeValid = isEdge
          ? !("item" in frame) &&
            EdgeSchema.safeParse(frame.edge).success &&
            (frame.source_type === undefined ||
              typeof frame.source_type === "string")
          : !("edge" in frame) &&
            ItemSchema.safeParse(frame.item).success &&
            ((frame.metadata === undefined &&
              eventType !== "metadata.changed") ||
              MetadataSchema.safeParse(frame.metadata).success);
        if (
          !WEBHOOK_EVENTS.some((known) => known === eventType) ||
          frame.type !== eventType ||
          !shapeValid
        ) {
          throw new Error("Outbound webhook event payload is inconsistent");
        }
        let complete = !event.enable_fanout;
        if (event.enable_fanout) {
          const pageLimit = 50 - examined;
          const subscriptions = await storage.outboundWebhooks.listAfter(
            position.afterSubscriptionId,
            pageLimit,
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
            if (eligible && subscription.type_filter) {
              const item = frame.item;
              eligible =
                typeof item === "object" &&
                item !== null &&
                "type" in item &&
                typeof item.type === "string" &&
                matchesTypePattern(item.type, [subscription.type_filter]);
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
                standing !== null &&
                (await frameInReach(storage, standing.key, frame)) !== null;
            }
            if (eligible) {
              // Allow one valid oversized payload; never reject accepted work.
              // A row stopped here is not examined/acknowledged until next pass.
              if (ids.length > 0 && queuedBytes + payloadBytes > byteTarget)
                break;
              ids.push(
                await storage.outboundWebhookDeliveries.schedule({
                  webhookId: subscription.id,
                  eventType,
                  payload: event.payload,
                  webhookUrl: subscription.url,
                  nextAttemptAt: new Date().toISOString(),
                }),
              );
              queuedBytes += payloadBytes;
            }
            examined++;
            pageExamined++;
            position.afterSubscriptionId = subscription.id;
            if (queuedBytes >= byteTarget || ids.length >= 50) break;
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
        ids,
        examined,
        fetched,
        scannedBytes,
        queuedBytes,
        cursor: position.lastEventId.toString(),
        event: position.eventId?.toString() ?? null,
      };
    });
    await Promise.allSettled(
      result.ids.map((id) => this.tryDirectDispatch(id)),
    );
    return {
      examined: result.examined,
      scheduled: result.ids.length,
      fetched: result.fetched,
      scannedBytes: result.scannedBytes,
      queuedBytes: result.queuedBytes,
      cursor: result.cursor,
      event: result.event,
    };
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
   * row up on its next run exactly as it would today.
   *
   * Fire-and-forget from the caller's perspective; all errors are logged
   * by `deliverWebhookAttempt`.
   */
  private async tryDirectDispatch(deliveryId: string): Promise<void> {
    try {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const claimExpiry = new Date(nowMs + CLAIM_LOCK_TTL_MS).toISOString();
      const claimed =
        await this.context.storage.outboundWebhookDeliveries.claimById(
          deliveryId,
          claimExpiry,
          now,
        );
      if (!claimed) return;
      await deliverWebhookAttempt(
        this.context,
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
// HTTP delivery with durable retry. Survives server restarts: the
// housekeeping scheduler runs it on the cadence below.
// ---------------------------------------------------------------------------

export const WEBHOOK_POLL_INTERVAL_MS = 30_000;

export class WebhookPoller {
  constructor(private context: WebhookDeliveryContext) {}

  /** One poll: every pending delivery that is due is attempted. Reports
   *  how many were. A failure to read the queue is the scheduler's to
   *  classify. */
  async runOnce(): Promise<{ attempted: number }> {
    const pending =
      await this.context.storage.outboundWebhookDeliveries.getPending(
        new Date().toISOString(),
        50,
      );
    await Promise.allSettled(
      pending.map((d) =>
        deliverWebhookAttempt(this.context, d, POLLER_TIMEOUT_MS, false),
      ),
    );
    return { attempted: pending.length };
  }
}
