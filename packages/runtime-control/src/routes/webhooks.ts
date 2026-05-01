import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";
import { MymeServerClient } from "../myme-client.js";
import { verifyHmacSha256 } from "../verify-hmac-sha256.js";

/**
 * Inbound webhook receiver.
 *
 *   1. Resolve subscription configs by `connection_id` from the Myme
 *      server (the broker key authenticates the lookup).
 *   2. Verify the delivery against each subscription's adapter; the
 *      first that passes wins. PR 4 ships HMAC-SHA256 only — the
 *      other four adapters return 501 with the method name in the
 *      reason so debugging is obvious. Layer 3 ports the rest as
 *      integrations need them.
 *   3. Enforce idempotency via the IDEMPOTENCY_KV namespace keyed by
 *      `${webhook_id}:${delivery_id}` with a 1-hour TTL. Duplicate
 *      receipts respond 200 without enqueuing.
 *   4. On success: enqueue { kind: "webhook", integration_name,
 *      connection_id, delivery_id, headers, body, verified_at_ms }
 *      onto WEBHOOK_RECEIPT_QUEUE; respond 202.
 *
 * The integration_name field on the queue message stays "" (empty)
 * until Layer 2 wires manifest persistence — per-Integration Workers
 * filter by their own integration_name and skip empty-targeted
 * messages until then. Layer 1's _template integration accepts
 * untargeted messages for the acceptance run.
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
    if (!env.WEBHOOK_RECEIPT_QUEUE) {
      return c.json(
        {
          error: "queue_unbound",
          message:
            "WEBHOOK_RECEIPT_QUEUE binding missing — provision and re-deploy.",
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
    // have exactly one subscription so the loop usually runs once.
    let matched: {
      sub: (typeof subscriptions)[number];
      deliveryId: string;
    } | null = null;
    let lastReason = "no_match";
    for (const sub of subscriptions) {
      if (sub.verification_method !== "hmac-sha256") {
        lastReason = `verification_method_not_implemented_in_layer_1:${sub.verification_method}`;
        continue;
      }
      const result = await verifyHmacSha256(
        rawBody,
        c.req.raw.headers,
        sub.secret,
      );
      if (result.verified) {
        matched = {
          sub,
          deliveryId: result.delivery_id ?? crypto.randomUUID(),
        };
        break;
      }
      lastReason = result.reason ?? "signature_mismatch";
    }
    if (!matched) {
      return c.json({ error: "verification_failed", reason: lastReason }, 401);
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

    await env.WEBHOOK_RECEIPT_QUEUE.send(
      {
        kind: "webhook",
        integration_name: "",
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
      },
      202,
    );
  });
}
