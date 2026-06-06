/**
 * `POST /runtime/webhook/:connection_id` — webhook receipt endpoint for
 * the local runtime substrate.
 *
 * Replaces the Cloudflare runtime-control Worker's `/webhooks/inbound/:
 * connection_id` endpoint when `MARFA_INTEGRATION_RUNTIME=local`. Same
 * verify-then-enqueue flow:
 *
 *   1. Resolve the connection's inbound webhook subscriptions.
 *   2. Verify the request against each subscription using
 *      `@withmarfa/webhooks` (already Web-Crypto only — works unchanged in
 *      Node).
 *   3. Look up the integration name from the connection's
 *      `integration_ref` → `system.integration` manifest.
 *   4. Idempotency check against the per-Connection `connection.runtime`
 *      idempotency window.
 *   5. Enqueue a `WebhookMessage` onto the local runtime's queue.
 *
 * Responses match the Cloudflare side exactly:
 *   - 202 on accept (`{ ok: true, connection_id, delivery_id }`)
 *   - 200 + `duplicate: true` when the delivery is already on file
 *   - 401 on verification failure
 *   - 404 when the connection has no matching subscriptions
 *   - 500 when the subscription has no resolvable integration name
 */
import { Hono } from "hono";
import { ADAPTERS, isVerificationMethod } from "@withmarfa/webhooks";
import type { ScheduleMessage, WebhookMessage } from "@withmarfa/runtime-sdk";
import { decryptSecret, SECRET_INFO } from "../../crypto/secret-encryption.js";
import { validateManifest } from "../validate-manifest.js";
import type { Storage } from "../../storage/interface.js";
import { checkAndRecordIdempotency } from "./pg-cursor-store.js";
import type { LocalRuntime } from "./types.js";

void ({} as ScheduleMessage); // ensure type import isn't tree-shaken

/** Idempotency window per connection (ms). Matches the CF KV TTL. */
const IDEMPOTENCY_WINDOW_MS = 3600 * 1000;

interface ConnectionProperties {
  kind?: string;
  status?: string;
  integration_ref?: string;
}

interface IntegrationProperties {
  manifest?: unknown;
}

/**
 * Mount the webhook receipt route on a Hono app. Exposed as a function
 * (rather than a sub-router) so the caller can decide whether to mount
 * under `/runtime/webhook/...` (production) or under a test-scoped
 * prefix.
 */
export function registerWebhookReceiptRoute(
  app: Hono,
  storage: Storage,
  runtime: LocalRuntime,
): void {
  app.post("/runtime/webhook/:connection_id", async (c) => {
    const connectionId = c.req.param("connection_id");
    if (!connectionId) {
      return c.json({ error: "missing_connection_id" }, 400);
    }

    const connection = await storage.items.get(connectionId);
    if (connection?.type !== "system.connection") {
      return c.json(
        { error: "connection_not_found", connection_id: connectionId },
        404,
      );
    }
    if (connection.state !== "active") {
      return c.json(
        {
          error: "connection_inactive",
          connection_id: connectionId,
          state: connection.state,
        },
        410,
      );
    }
    const props = connection.properties as ConnectionProperties;
    if (props.kind !== "integration") {
      return c.json({ error: "connection_not_integration_kind" }, 400);
    }
    if (!props.integration_ref) {
      return c.json({ error: "integration_ref_missing" }, 400);
    }
    const integration = await storage.items.get(props.integration_ref);
    if (integration?.type !== "system.integration") {
      return c.json({ error: "integration_ref_unresolved" }, 500);
    }
    const validated = validateManifest(
      (integration.properties as IntegrationProperties).manifest,
    );
    if (!validated.ok) {
      return c.json({ error: "integration_manifest_invalid" }, 500);
    }
    const integrationName = validated.manifest.name;

    const subscriptions = await storage.inboundWebhooks.listByConnection(
      connectionId,
      connection.tenant_id ?? undefined,
    );
    if (subscriptions.length === 0) {
      return c.json(
        { error: "no_subscriptions", connection_id: connectionId },
        404,
      );
    }

    const rawBody = await c.req.arrayBuffer();

    // First subscription that verifies wins; disabled ones are skipped.
    let matched: {
      subscriptionId: string;
      deliveryId: string;
    } | null = null;
    let lastReason = "no_match";
    for (const sub of subscriptions) {
      if (sub.disabled) continue;
      if (!isVerificationMethod(sub.verification_method)) {
        lastReason = `unknown_verification_method:${sub.verification_method}`;
        continue;
      }
      const adapter = ADAPTERS[sub.verification_method];
      const secret = decryptSecret(
        sub.secret_encrypted,
        SECRET_INFO.inboundWebhookSecret,
      );
      const result = await adapter(rawBody, c.req.raw.headers, secret);
      if (result.verified) {
        matched = {
          subscriptionId: sub.id,
          deliveryId: result.external_delivery_id ?? crypto.randomUUID(),
        };
        break;
      }
      lastReason = result.reason ?? "signature_mismatch";
    }
    if (!matched) {
      return c.json({ error: "verification_failed", reason: lastReason }, 401);
    }

    // Short-circuit on a recent matching delivery; delivery ids are scoped per-connection.
    const idempotencyKey = `${matched.subscriptionId}:${matched.deliveryId}`;
    const { isDuplicate } = await checkAndRecordIdempotency(
      storage,
      connectionId,
      idempotencyKey,
      IDEMPOTENCY_WINDOW_MS,
    );
    if (isDuplicate) {
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

    const headerMap: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headerMap[key] = value;
    });
    const bodyBytes = new Uint8Array(rawBody);
    let bodyString = "";
    for (const byte of bodyBytes) {
      bodyString += String.fromCharCode(byte);
    }
    const bodyBase64 =
      typeof btoa === "function"
        ? btoa(bodyString)
        : Buffer.from(bodyBytes).toString("base64");

    const message: WebhookMessage = {
      kind: "webhook",
      integration_name: integrationName,
      connection_id: connectionId,
      ...(connection.tenant_id ? { tenant_id: connection.tenant_id } : {}),
      delivery_id: matched.deliveryId,
      headers: headerMap,
      body_base64: bodyBase64,
      verified_at_ms: Date.now(),
    };
    await runtime.enqueue({ integration_name: integrationName, message });

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
