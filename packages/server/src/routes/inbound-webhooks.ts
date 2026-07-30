import { createRoute, z } from "@hono/zod-openapi";
import { randomBytes } from "node:crypto";
import {
  MarfaError,
  ErrorCode,
  generateId,
  type CreatedInboundWebhook,
  type InboundWebhook,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, hasSpaceAdminAuthority } from "../middleware/auth.js";
import type { Storage, InboundWebhookRow } from "../storage/interface.js";
import { resolveConnectionManifest } from "../connections/resolve-manifest.js";
import {
  encryptSecret,
  decryptSecret,
  SECRET_INFO,
} from "../crypto/secret-encryption.js";
import { ADAPTERS, isVerificationMethod } from "@withmarfa/webhooks";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Last-4-char redaction for list/get responses. The full secret only
 *  ever appears in the 201 create response; subsequent reads always go
 *  through this. */
function redactSecret(raw: string): string {
  if (raw.length <= 4) return raw;
  return "****" + raw.slice(-4);
}

function rowToWire(
  row: InboundWebhookRow,
  rawSecret?: string,
): InboundWebhook | CreatedInboundWebhook {
  // Cast is safe: validation at write time (validateManifest) enforced the discriminated union.
  const verification_method = row.verification_method as
    | "hmac-sha256"
    | "slack"
    | "stripe"
    | "github";
  const base: InboundWebhook = {
    id: row.id,
    space_id: row.space_id ?? undefined,
    connection_id: row.connection_id,
    external_service_id: row.external_service_id ?? undefined,
    secret_redacted: rawSecret
      ? redactSecret(rawSecret)
      : "****" + row.secret_encrypted.slice(-4),
    verification_method,
    verification_adapter_id: row.verification_adapter_id ?? undefined,
    events: row.events,
    disabled: row.disabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (rawSecret) return { ...base, secret: rawSecret };
  return base;
}

/**
 * Validates that the caller can mutate inbound webhook subscriptions
 * for the given connection. The caller must be authenticated AND match
 * either:
 *   1. An admin credential whose space scope covers the connection.
 *   2. The connector's own credential — a credential whose `source` is
 *      `oauth:${connectionId}` (the OAuth-token synthetic credential
 *      pattern from the auth middleware).
 *
 * `c` is typed via the Hono Context import to avoid a self-referencing
 * router type — we don't need OpenAPI-specific context here, just the
 * standard env + var bindings.
 */
async function requireConnectionAccess(
  c: import("hono").Context<AppEnv>,
  storage: Storage,
  connectionId: string,
): Promise<{ spaceId: string | undefined }> {
  const key = requireAuth(c);
  const spaceId = key.space_id ?? undefined;
  const connection = await storage.items.get(connectionId, spaceId);
  if (connection?.type !== "system.connection") {
    throw new MarfaError(
      ErrorCode.CONNECTION_NOT_FOUND,
      "Connection not found",
    );
  }
  // Space-bounded admin authority, matching
  // `requireConnectionProxyAccess`: the connection lookup above is fenced
  // on `key.space_id`, so rank decides what the caller may do and the
  // fence decides which connections it can see.
  const isAdmin = hasSpaceAdminAuthority(key) || key.is_platform;
  // Same widening as `requireConnectionProxyAccess` in
  // `routes/connection-proxy.ts` — accept runtime credentials minted
  // for this connection alongside the OAuth-app-grant shape.
  const isConnector =
    key.source === `oauth:${connectionId}` ||
    (key.is_runtime_credential === true && key.connection_id === connectionId);
  if (!isAdmin && !isConnector) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Caller cannot manage inbound webhooks on this connection",
    );
  }
  return { spaceId };
}

// ---------------------------------------------------------------------------
// OpenAPI schemas
// ---------------------------------------------------------------------------

const InboundWebhookSchema = z.object({
  id: z.string(),
  space_id: z.string().optional(),
  connection_id: z.string(),
  external_service_id: z.string().optional(),
  secret_redacted: z.string(),
  verification_method: z.enum(["hmac-sha256", "slack", "stripe", "github"]),
  verification_adapter_id: z.string().optional(),
  events: z.array(z.string()),
  disabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const CreatedInboundWebhookSchema = InboundWebhookSchema.extend({
  secret: z.string(),
});

const InboundWebhookEventSchema = z.object({
  id: z.string(),
  inbound_webhook_id: z.string(),
  external_delivery_id: z.string(),
  received_at: z.string(),
  payload: z.string(),
  verified: z.boolean(),
  processed_at: z.string().nullable(),
  processing_error: z.string().nullable(),
  retry_count: z.number(),
  next_attempt_at: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Route definitions — subscription scope (mounted under /connections)
// ---------------------------------------------------------------------------

const ConnectionIdParam = z.object({
  id: z.string().describe("Id of the connection the subscription belongs to."),
});

const createInboundWebhookRoute = createRoute({
  operationId: "createInboundWebhook",
  method: "post",
  path: "/{id}/inbound-webhooks",
  tags: ["Inbound Webhooks"],
  summary: "Register an inbound webhook subscription on a connection",
  description:
    "Registers an inbound-webhook subscription so the connection's upstream service can deliver events into Marfa. Signature verification uses the adapter named in the connection manifest's `webhook_verification.method`; the `secret` is returned only once, in this response.",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            external_service_id: z.string().optional(),
            events: z.array(z.string()).min(1),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CreatedInboundWebhookSchema } },
      description:
        "Subscription created. The `secret` field is returned ONCE; subsequent reads redact it.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description: "Validation error or invalid manifest",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller cannot manage this connection",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "Connection not found",
    },
  },
});

const listInboundWebhooksRoute = createRoute({
  operationId: "listInboundWebhooks",
  method: "get",
  path: "/{id}/inbound-webhooks",
  tags: ["Inbound Webhooks"],
  summary: "List inbound webhook subscriptions on a connection",
  description:
    "Returns every inbound-webhook subscription attached to the connection. Secrets are redacted here — they only return at creation time.",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            inbound_webhooks: z.array(InboundWebhookSchema),
          }),
        },
      },
      description: "Subscriptions for this connection (secrets redacted)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller cannot read this connection",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "Connection not found",
    },
  },
});

const InboundWebhookIdsParam = z.object({
  id: z.string().describe("Id of the connection the subscription belongs to."),
  webhook_id: z.string().describe("Id of the inbound webhook subscription."),
});

const listDeliveriesRoute = createRoute({
  operationId: "listInboundWebhookDeliveries",
  method: "get",
  path: "/{id}/inbound-webhooks/{webhook_id}/deliveries",
  tags: ["Inbound Webhooks"],
  summary: "List recent receipts for an inbound webhook subscription",
  description:
    "Returns recent inbound deliveries received on this subscription, newest first, recording each receipt's verification and dispatch outcome. Use to debug a failing connector or audit what the upstream service has sent.",
  security: [{ bearerAuth: [] }],
  request: {
    params: InboundWebhookIdsParam,
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of deliveries to return."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            deliveries: z.array(InboundWebhookEventSchema),
          }),
        },
      },
      description: "Recent receipts (verified + unverified)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller cannot read this connection",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "connection_not_found",
            "inbound_webhook_not_found",
          ]),
        },
      },
      description: "Connection or subscription not found",
    },
  },
});

const RetryParams = z.object({
  id: z.string().describe("Id of the connection the subscription belongs to."),
  webhook_id: z.string().describe("Id of the inbound webhook subscription."),
  event_id: z.string().describe("Id of the delivery to replay."),
});

const retryDeliveryRoute = createRoute({
  operationId: "retryInboundWebhookDelivery",
  method: "post",
  path: "/{id}/inbound-webhooks/{webhook_id}/deliveries/{event_id}/retry",
  tags: ["Inbound Webhooks"],
  summary: "Replay an inbound webhook delivery",
  description:
    "Re-dispatches a previously-received inbound delivery from the DLQ with its original envelope intact. Signature verification is not re-run and the dedup window is bypassed, since the operator is deliberately re-delivering.",
  security: [{ bearerAuth: [] }],
  request: { params: RetryParams },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Event row reset; back in the pending queue",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller cannot manage this connection",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "connection_not_found",
            "inbound_webhook_not_found",
            "inbound_webhook_event_not_found",
          ]),
        },
      },
      description: "Connection, subscription, or event not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Subscription router
// ---------------------------------------------------------------------------

export function inboundWebhookSubscriptionRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  // POST /connections/:id/inbound-webhooks
  r.openapi(createInboundWebhookRoute, async (c) => {
    const { id: connectionId } = c.req.valid("param");
    const { spaceId } = await requireConnectionAccess(c, storage, connectionId);
    const body = c.req.valid("json");

    const { manifest } = await resolveConnectionManifest(
      storage,
      connectionId,
      spaceId,
    );

    const verification_method = manifest.webhook_verification.method;
    const verification_adapter_id: string | undefined = undefined;

    const rawSecret = randomBytes(32).toString("hex");
    const secret_encrypted = encryptSecret(
      rawSecret,
      SECRET_INFO.inboundWebhookSecret,
    );

    const id = generateId();
    const row = await storage.inboundWebhooks.create({
      id,
      space_id: spaceId,
      connection_id: connectionId,
      external_service_id: body.external_service_id,
      secret_encrypted,
      verification_method,
      verification_adapter_id,
      events: body.events,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "inbound_webhook.create",
      resource_type: "inbound_webhook",
      resource_id: id,
    });

    const response = rowToWire(row, rawSecret) as CreatedInboundWebhook;
    return c.json(response, 201);
  });

  // GET /connections/:id/inbound-webhooks
  r.openapi(listInboundWebhooksRoute, async (c) => {
    const { id: connectionId } = c.req.valid("param");
    const { spaceId } = await requireConnectionAccess(c, storage, connectionId);
    const rows = await storage.inboundWebhooks.listByConnection(
      connectionId,
      spaceId,
    );
    return c.json({ inbound_webhooks: rows.map((r) => rowToWire(r)) }, 200);
  });

  // GET /connections/:id/inbound-webhooks/:webhook_id/deliveries
  r.openapi(listDeliveriesRoute, async (c) => {
    const { id: connectionId, webhook_id } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const { spaceId } = await requireConnectionAccess(c, storage, connectionId);
    const subscription = await storage.inboundWebhooks.get(webhook_id, spaceId);
    if (subscription?.connection_id !== connectionId) {
      throw new MarfaError(
        ErrorCode.INBOUND_WEBHOOK_NOT_FOUND,
        "Inbound webhook subscription not found",
      );
    }
    const deliveries = await storage.inboundWebhookEvents.list(
      webhook_id,
      limit,
    );
    return c.json({ deliveries }, 200);
  });

  // POST /connections/:id/inbound-webhooks/:webhook_id/deliveries/:event_id/retry
  r.openapi(retryDeliveryRoute, async (c) => {
    const { id: connectionId, webhook_id, event_id } = c.req.valid("param");
    const { spaceId } = await requireConnectionAccess(c, storage, connectionId);
    const subscription = await storage.inboundWebhooks.get(webhook_id, spaceId);
    if (subscription?.connection_id !== connectionId) {
      throw new MarfaError(
        ErrorCode.INBOUND_WEBHOOK_NOT_FOUND,
        "Inbound webhook subscription not found",
      );
    }
    const event = await storage.inboundWebhookEvents.get(event_id);
    if (event?.inbound_webhook_id !== webhook_id) {
      throw new MarfaError(
        ErrorCode.INBOUND_WEBHOOK_EVENT_NOT_FOUND,
        "Inbound webhook event not found",
      );
    }
    await storage.inboundWebhookEvents.resetForRetry(
      event_id,
      new Date().toISOString(),
    );
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "inbound_webhook.retry",
      resource_type: "inbound_webhook_event",
      resource_id: event_id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return r;
}

// ---------------------------------------------------------------------------
// Public receipt route (mounted under /webhooks/inbound)
// ---------------------------------------------------------------------------

const ReceiptIdParam = z.object({
  id: z.string().describe("Id of the inbound webhook subscription."),
});

// The receipt route deliberately omits a `body` schema. HMAC verification
// requires the raw bytes — `@hono/zod-openapi`'s body validator parses
// the request as JSON, which consumes the stream before our handler can
// read it via `c.req.raw.arrayBuffer()`. Skipping the body schema keeps
// the request stream intact. The OpenAPI spec carries the path + status
// codes; the per-Integration body shape is documented elsewhere.
const receiveInboundWebhookRoute = createRoute({
  operationId: "deliverInboundWebhook",
  method: "post",
  path: "/{id}",
  tags: ["Inbound Webhooks"],
  summary: "Deliver an inbound webhook",
  description:
    "Public receipt endpoint that accepts a signed payload from an external service, verifies its signature, deduplicates against the sender's delivery id, and enqueues the envelope for processing. Failed verification returns 401 and the body is not forwarded.",
  request: {
    params: ReceiptIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Verified and accepted (or duplicate, idempotent)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "inbound_webhook_verification_failed",
          ]),
        },
      },
      description: "Signature verification failed",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["inbound_webhook_not_found"]),
        },
      },
      description: "Subscription not found",
    },
    410: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["inbound_webhook_disabled"]),
        },
      },
      description: "Subscription is disabled",
    },
  },
});

export function inboundWebhookReceiptRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(receiveInboundWebhookRoute, async (c) => {
    const { id } = c.req.valid("param");

    const subscription = await storage.inboundWebhooks.getAny(id);
    if (!subscription) {
      throw new MarfaError(
        ErrorCode.INBOUND_WEBHOOK_NOT_FOUND,
        "Inbound webhook subscription not found",
      );
    }
    if (subscription.disabled) {
      throw new MarfaError(
        ErrorCode.INBOUND_WEBHOOK_DISABLED,
        "Inbound webhook subscription is disabled",
      );
    }

    if (!isVerificationMethod(subscription.verification_method)) {
      // Defensive — the column was validated at write time, but if the
      // DB drifts (manual edit, post-restore corruption) we surface
      // 401 rather than crash.
      throw new MarfaError(
        ErrorCode.INBOUND_WEBHOOK_VERIFICATION_FAILED,
        `Unknown verification method: ${subscription.verification_method}`,
      );
    }

    // Raw ArrayBuffer — framework re-serialization would invalidate the HMAC. Same buffer feeds JSON decoding.
    const rawBody = await c.req.raw.arrayBuffer();

    let secret: string;
    try {
      secret = decryptSecret(
        subscription.secret_encrypted,
        SECRET_INFO.inboundWebhookSecret,
      );
    } catch {
      // Decryption failure is corruption / wrong MARFA_AUTH_SECRET. The
      // sender shouldn't see the internals; surface as an opaque
      // verification failure (and let operators see the audit row).
      throw new MarfaError(
        ErrorCode.INBOUND_WEBHOOK_VERIFICATION_FAILED,
        "Verification subsystem error",
      );
    }

    const adapter = ADAPTERS[subscription.verification_method];
    const result = await adapter(rawBody, c.req.raw.headers, secret);

    const now = new Date().toISOString();
    const externalDeliveryId = result.external_delivery_id ?? generateId();

    const written = await storage.inboundWebhookEvents.insert({
      id: generateId(),
      inbound_webhook_id: id,
      external_delivery_id: externalDeliveryId,
      received_at: now,
      payload: new TextDecoder("utf-8").decode(rawBody),
      verified: result.verified,
      processing_error: result.verified ? undefined : result.reason,
    });

    if (!result.verified) {
      throw new MarfaError(
        ErrorCode.INBOUND_WEBHOOK_VERIFICATION_FAILED,
        result.reason ?? "Signature verification failed",
      );
    }

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: undefined,
      action: written.inserted
        ? "inbound_webhook.receive"
        : "inbound_webhook.receive_duplicate",
      resource_type: "inbound_webhook_event",
      resource_id: written.id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return r;
}
