import { Hono } from "hono";
import { ADAPTERS } from "@mymehq/webhooks";
import type { ControlPlaneEnv } from "../env.js";
import { MymeServerClient } from "../myme-client.js";

/** Slim shape — mirror of the `QueueProducer` shape in env.ts. */
interface QueueProducer {
  send(
    body: unknown,
    opts?: { contentType?: "json" | "text" | "v8" },
  ): Promise<void>;
}

/**
 * Per-integration webhook-receipt queue routing (T-247). Each
 * integration with a `webhook` trigger gets its own queue and its own
 * producer binding on the control plane. Cloudflare Queues allow only
 * one consumer per queue; the runtime-sdk's envelope filter on
 * `integration_name` is a defence-in-depth check that only fires
 * AFTER a message reaches a consumer, so a shared queue would
 * silently filter out every integration except the one that owns the
 * consumer slot. Pre-T-247 this collapsed onto github-webhooks.
 *
 * The resolver returns the per-integration producer when one is
 * bound, falling back to the legacy shared `WEBHOOK_RECEIPT_QUEUE`
 * for backward compatibility with github-webhooks. Returning
 * `undefined` means no producer is wired — the route returns 503.
 */
export function resolveWebhookQueueProducer(
  env: ControlPlaneEnv,
  integrationName: string,
): { producer: QueueProducer; routedVia: "dedicated" | "shared" } | undefined {
  const dedicated = pickDedicatedProducer(env, integrationName);
  if (dedicated) return { producer: dedicated, routedVia: "dedicated" };
  if (env.WEBHOOK_RECEIPT_QUEUE) {
    return { producer: env.WEBHOOK_RECEIPT_QUEUE, routedVia: "shared" };
  }
  return undefined;
}

function pickDedicatedProducer(
  env: ControlPlaneEnv,
  integrationName: string,
): QueueProducer | undefined {
  switch (integrationName) {
    case "mymehq.inbox":
      return env.WEBHOOK_RECEIPT_QUEUE_MYMEHQ_INBOX;
    case "google.calendar":
      return env.WEBHOOK_RECEIPT_QUEUE_GOOGLE_CALENDAR;
    default:
      return undefined;
  }
}

/** True iff at least one webhook-receipt producer is bound. Used by
 *  the route's early sanity check to fail fast on a misconfigured
 *  deployment (no queues at all) rather than letting the per-
 *  integration resolver surface the same error per-request later. */
function hasAnyWebhookProducer(env: ControlPlaneEnv): boolean {
  return (
    env.WEBHOOK_RECEIPT_QUEUE !== undefined ||
    env.WEBHOOK_RECEIPT_QUEUE_MYMEHQ_INBOX !== undefined ||
    env.WEBHOOK_RECEIPT_QUEUE_GOOGLE_CALENDAR !== undefined
  );
}

/**
 * Inbound webhook receiver.
 *
 *   1. Resolve subscription configs by `connection_id` from the Myme
 *      server (the broker key authenticates the lookup).
 *   2. Verify the delivery against each subscription's adapter; the
 *      first that passes wins. T-009 lifted all four supported methods
 *      (HMAC-SHA256, Slack, Stripe, GitHub) into the control plane;
 *      T-035 consolidated them into `@mymehq/webhooks` so the
 *      Worker control plane and the Node-side server share one
 *      Web-Crypto implementation. The previously-stubbed `custom`
 *      method was dropped in T-011.
 *   3. Enforce idempotency via the IDEMPOTENCY_KV namespace keyed by
 *      `${webhook_id}:${delivery_id}` with a 1-hour TTL. Duplicate
 *      receipts respond 200 without enqueuing.
 *   4. On success: enqueue { kind: "webhook", integration_name,
 *      connection_id, delivery_id, headers, body_base64,
 *      verified_at_ms } onto WEBHOOK_RECEIPT_QUEUE; respond 202.
 *
 * `integration_name` on the queue message is stamped from the matched
 * subscription's projected `integration_name` (T-009) — the per-
 * Integration Worker's envelope filter then accepts it. Subscriptions
 * whose connection has no resolvable integration_ref get an empty
 * integration_name and the receipt is rejected so the runtime layer
 * never sees an unrouteable message.
 */
export function registerWebhookRoutes(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/webhooks/inbound/:connection_id", async (c) => {
    const connectionId = c.req.param("connection_id");
    if (!connectionId) {
      return c.json({ error: "missing_connection_id" }, 400);
    }
    const env = c.env;
    if (!env.MYME_API_URL || !env.MYME_RUNTIME_BROKER_KEY) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message: "MYME_API_URL and MYME_RUNTIME_BROKER_KEY must both be set.",
        },
        503,
      );
    }
    // T-247 — early sanity check: if no webhook-receipt producer
    // binding is wired AT ALL (neither the legacy shared nor any
    // per-integration), fail fast with a clear deploy-misconfigured
    // 503. The per-integration resolver lower down handles the
    // narrower case "the requested integration's producer isn't
    // wired" once we know which integration it routes to.
    if (!hasAnyWebhookProducer(env)) {
      return c.json(
        {
          error: "queue_unbound",
          message:
            "No webhook-receipt queue producer is bound. Provision the queues and re-deploy.",
        },
        503,
      );
    }
    const rawBody = await c.req.arrayBuffer();
    const myme = new MymeServerClient(
      env.MYME_API_URL,
      env.MYME_RUNTIME_BROKER_KEY,
    );

    let subscriptions;
    try {
      subscriptions =
        await myme.lookupInboundWebhookSubscriptions(connectionId);
    } catch (err) {
      return c.json(
        {
          error: "subscription_lookup_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
    if (subscriptions.length === 0) {
      return c.json(
        { error: "no_subscriptions", connection_id: connectionId },
        404,
      );
    }

    // Try each subscription; first that verifies wins. Most connections
    // have exactly one subscription so the loop usually runs once. The
    // `ADAPTERS` table from `@mymehq/webhooks` covers all four
    // supported methods — unknown methods (shouldn't happen post-T-011
    // since the manifest schema rejects them) get a clear error.
    let matched: {
      sub: (typeof subscriptions)[number];
      deliveryId: string;
    } | null = null;
    let lastReason = "no_match";
    for (const sub of subscriptions) {
      const adapter = ADAPTERS[sub.verification_method];
      // The dispatch table is exhaustive over the wire-typed
      // verification_method union, so a missing entry would mean the
      // server returned a method this control plane doesn't know.
      // Treat it as a routing failure.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defence against drift between server's wider stored set and the control plane's compile-time union
      if (!adapter) {
        lastReason = `unknown_verification_method:${sub.verification_method}`;
        continue;
      }
      const result = await adapter(rawBody, c.req.raw.headers, sub.secret);
      if (result.verified) {
        matched = {
          sub,
          deliveryId: result.external_delivery_id ?? crypto.randomUUID(),
        };
        break;
      }
      lastReason = result.reason ?? "signature_mismatch";
    }
    if (!matched) {
      return c.json({ error: "verification_failed", reason: lastReason }, 401);
    }
    // T-009: refuse to enqueue a message we can't route — without a
    // resolved integration_name, the per-Integration Worker's envelope
    // filter would silently drop it.
    if (
      !matched.sub.integration_name ||
      matched.sub.integration_name.length === 0
    ) {
      return c.json(
        {
          error: "subscription_unrouteable",
          reason:
            "subscription has no integration_name (connection's integration_ref unresolved)",
        },
        500,
      );
    }

    // T-247: resolve the per-integration queue producer (with the
    // shared queue as fallback for github-webhooks). Done here, AFTER
    // verification + integration_name resolution, so the 503
    // surfaces a real misconfiguration (binding missing for an
    // integration we routed to) rather than a generic 503 on every
    // request.
    const queueChoice = resolveWebhookQueueProducer(
      env,
      matched.sub.integration_name,
    );
    if (!queueChoice) {
      return c.json(
        {
          error: "queue_unbound",
          message: `No webhook-receipt queue producer is bound for integration '${matched.sub.integration_name}'. Add a per-integration binding to wrangler.control.toml or wire the shared WEBHOOK_RECEIPT_QUEUE fallback.`,
        },
        503,
      );
    }

    // Idempotency: drop deliveries we've already enqueued in the recent
    // past. KV TTL (3600s) bounds the cache size.
    if (env.IDEMPOTENCY_KV) {
      const key = `${matched.sub.id}:${matched.deliveryId}`;
      const existing = await env.IDEMPOTENCY_KV.get(key);
      if (existing) {
        return c.json(
          {
            ok: true,
            duplicate: true,
            connection_id: connectionId,
            delivery_id: matched.deliveryId,
          },
          200,
        );
      }
      await env.IDEMPOTENCY_KV.put(key, "1", { expirationTtl: 3600 });
    }

    // Headers → plain object for the queue message envelope.
    const headerMap: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headerMap[key] = value;
    });

    // Body as base64 so it survives JSON serialization. The SDK's
    // WebhookMessage.body is ArrayBuffer; the consumer decodes.
    const bodyBytes = new Uint8Array(rawBody);
    let bodyString = "";
    for (const byte of bodyBytes) {
      bodyString += String.fromCharCode(byte);
    }
    const bodyBase64 = btoa(bodyString);

    await queueChoice.producer.send(
      {
        kind: "webhook",
        integration_name: matched.sub.integration_name,
        connection_id: connectionId,
        delivery_id: matched.deliveryId,
        headers: headerMap,
        body_base64: bodyBase64,
        verified_at_ms: Date.now(),
        webhook_id: matched.sub.id,
      },
      { contentType: "json" },
    );

    return c.json(
      {
        ok: true,
        connection_id: connectionId,
        delivery_id: matched.deliveryId,
        routed_via: queueChoice.routedVia,
      },
      202,
    );
  });
}
