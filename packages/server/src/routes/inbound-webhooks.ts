import { createRoute, z } from "@hono/zod-openapi";
import { randomBytes } from "node:crypto";
import {
  MymeError,
  ErrorCode,
  generateId,
  type CreatedInboundWebhook,
  type InboundWebhook,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage, InboundWebhookRow } from "../storage/interface.js";
import { resolveConnectionManifest } from "../connections/resolve-manifest.js";
import {
  encryptSecret,
  decryptSecret,
  SECRET_INFO,
} from "../crypto/secret-encryption.js";
import {
  ADAPTERS,
  isVerificationMethod,
} from "../inbound-webhooks/verification/index.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
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
  // Verification method is validated at write time (manifest
  // validateManifest gates the input via the discriminated union) so
  // the cast here is safe; we widen for the wire type.
  const verification_method = row.verification_method as
    | "hmac-sha256"
    | "slack"
    | "stripe"
    | "github";
  const base: InboundWebhook = {
    id: row.id,
    tenant_id: row.tenant_id ?? undefined,
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
 * for the given connection. Workstream 2 PR 5 narrow gate: the caller
 * must be authenticated AND match either:
 *   1. An admin credential whose tenant scope covers the connection.
 *   2. The connector's own credential — credential whose `source` is
 *      `oauth:${connectionId}` (the OAuth-token synthetic credential
 *      pattern from the auth middleware).
 *
 * Tenant scoping in WS2 leans on tenant_id matching; full RBAC ladders
 * (per-Connection ACLs, etc.) are deferred to WS3 alongside the runtime.
 *
 * `c` is typed via the Hono Context import to avoid a self-referencing
 * router type — we don't need OpenAPI-specific context here, just the
 * standard env + var bindings.
 */
async function requireConnectionAccess(
  c: import("hono").Context<AppEnv>,
  storage: Storage,
  connectionId: string,
): Promise<{ tenantId: string | undefined }> {
  const key = requireAuth(c);
  // Admin (member-level + admin role) keys can manage any connection in
  // their tenant. Connector credentials (OAuth tokens) carry source
  // `oauth:<connectionId>`; we accept that shape directly.
  const tenantId = key.tenant_id ?? undefined;
  const connection = await storage.items.get(connectionId, tenantId);
  if (connection?.type !== "system.connection") {
    throw new MymeError(ErrorCode.NOT_FOUND, "Connection not found");
  }
  const isAdmin = key.role === "admin" || key.is_platform;
  const isConnector = key.source === `oauth:${connectionId}`;
  if (!isAdmin && !isConnector) {
    throw new MymeError(
      ErrorCode.FORBIDDEN,
      "Caller cannot manage inbound webhooks on this connection",
    );
  }
  return { tenantId };
}

// ---------------------------------------------------------------------------
// OpenAPI schemas
// ---------------------------------------------------------------------------

const InboundWebhookSchema = z.object({
  id: z.string(),
  tenant_id: z.string().optional(),
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

const ConnectionIdParam = z.object({ id: z.string() });

const createInboundWebhookRoute = createRoute({
  method: "post",
  path: "/{id}/inbound-webhooks",
  tags: ["Inbound Webhooks"],
  summary: "Register an inbound webhook subscription on a connection",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            external_service_id: z.string().optional(),
            events: z.array(z.string()).min(1),
            // Layer 2 PR 2: manifest is no longer required in the body —
            // the route resolves it via the connection's `integration_ref`
            // → `system.integration` item. Inline `manifest` remains
            // accepted for one release as a fallback for connections
            // installed before Layer 2; that path is removed in a
            // follow-up PR after callers migrate.
            manifest: z.unknown().optional(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error or invalid manifest",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller cannot manage this connection",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection not found",
    },
  },
});

const listInboundWebhooksRoute = createRoute({
  method: "get",
  path: "/{id}/inbound-webhooks",
  tags: ["Inbound Webhooks"],
  summary: "List inbound webhook subscriptions on a connection",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller cannot read this connection",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection not found",
    },
  },
});

const InboundWebhookIdsParam = z.object({
  id: z.string(),
  webhook_id: z.string(),
});

const listDeliveriesRoute = createRoute({
  method: "get",
  path: "/{id}/inbound-webhooks/{webhook_id}/deliveries",
  tags: ["Inbound Webhooks"],
  summary: "List recent receipts for an inbound webhook subscription",
  security: [{ bearerAuth: [] }],
  request: {
    params: InboundWebhookIdsParam,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller cannot read this connection",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection or subscription not found",
    },
  },
});

const RetryParams = z.object({
  id: z.string(),
  webhook_id: z.string(),
  event_id: z.string(),
});

const retryDeliveryRoute = createRoute({
  method: "post",
  path: "/{id}/inbound-webhooks/{webhook_id}/deliveries/{event_id}/retry",
  tags: ["Inbound Webhooks"],
  summary: "Reset an event row for manual replay from DLQ",
  security: [{ bearerAuth: [] }],
  request: { params: RetryParams },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Event row reset; back in the pending queue",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller cannot manage this connection",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
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
    const { tenantId } = await requireConnectionAccess(
      c,
      storage,
      connectionId,
    );
    const body = c.req.valid("json");

    // Layer 2 PR 2: prefer the manifest persisted under the connection's
    // `integration_ref` over the inline body. Falls back to the inline
    // path when the connection has no integration_ref (legacy
    // pre-Layer-2 connections).
    const { manifest } = await resolveConnectionManifest(
      storage,
      connectionId,
      tenantId,
      body.manifest,
    );

    // Stamp method on the new row from the validated manifest. The
    // legacy `verification_adapter_id` column was reserved for the
    // dropped `custom` method (T-011); always undefined now.
    const verification_method = manifest.webhook_verification.method;
    const verification_adapter_id: string | undefined = undefined;

    // Fresh 32-byte hex secret, encrypted at rest.
    const rawSecret = randomBytes(32).toString("hex");
    const secret_encrypted = encryptSecret(
      rawSecret,
      SECRET_INFO.inboundWebhookSecret,
    );

    const id = generateId();
    const row = await storage.inboundWebhooks.create({
      id,
      tenant_id: tenantId,
      connection_id: connectionId,
      external_service_id: body.external_service_id,
      secret_encrypted,
      verification_method,
      verification_adapter_id,
      events: body.events,
    });

    void storage.audit.log({
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
    const { tenantId } = await requireConnectionAccess(
      c,
      storage,
      connectionId,
    );
    const rows = await storage.inboundWebhooks.listByConnection(
      connectionId,
      tenantId,
    );
    return c.json(
      { inbound_webhooks: rows.map((r) => rowToWire(r) as InboundWebhook) },
      200,
    );
  });

  // GET /connections/:id/inbound-webhooks/:webhook_id/deliveries
  r.openapi(listDeliveriesRoute, async (c) => {
    const { id: connectionId, webhook_id } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const { tenantId } = await requireConnectionAccess(
      c,
      storage,
      connectionId,
    );
    const subscription = await storage.inboundWebhooks.get(
      webhook_id,
      tenantId,
    );
    if (subscription?.connection_id !== connectionId) {
      throw new MymeError(
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
    const { tenantId } = await requireConnectionAccess(
      c,
      storage,
      connectionId,
    );
    const subscription = await storage.inboundWebhooks.get(
      webhook_id,
      tenantId,
    );
    if (subscription?.connection_id !== connectionId) {
      throw new MymeError(
        ErrorCode.INBOUND_WEBHOOK_NOT_FOUND,
        "Inbound webhook subscription not found",
      );
    }
    const event = await storage.inboundWebhookEvents.get(event_id);
    if (event?.inbound_webhook_id !== webhook_id) {
      throw new MymeError(
        ErrorCode.INBOUND_WEBHOOK_EVENT_NOT_FOUND,
        "Inbound webhook event not found",
      );
    }
    await storage.inboundWebhookEvents.resetForRetry(
      event_id,
      new Date().toISOString(),
    );
    void storage.audit.log({
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

const ReceiptIdParam = z.object({ id: z.string() });

// The receipt route deliberately omits a `body` schema. HMAC verification
// requires the raw bytes — `@hono/zod-openapi`'s body validator parses
// the request as JSON, which consumes the stream before our handler can
// read it via `c.req.raw.arrayBuffer()`. Skipping the body schema keeps
// the request stream intact. The OpenAPI spec carries the path + status
// codes; the per-Integration body shape is documented elsewhere.
const receiveInboundWebhookRoute = createRoute({
  method: "post",
  path: "/{id}",
  tags: ["Inbound Webhooks"],
  summary: "Receive a signed payload from an external service (public)",
  request: {
    params: ReceiptIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Verified and accepted (or duplicate, idempotent)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Signature verification failed",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Subscription not found",
    },
    410: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Subscription is disabled",
    },
  },
});

export function inboundWebhookReceiptRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(receiveInboundWebhookRoute, async (c) => {
    const { id } = c.req.valid("param");

    // Public unauth endpoint — no requireAuth call. Tenant scoping is
    // off the connection_id stamped on the row at subscription time;
    // receipt itself is public.
    const subscription = await storage.inboundWebhooks.getAny(id);
    if (!subscription) {
      throw new MymeError(
        ErrorCode.INBOUND_WEBHOOK_NOT_FOUND,
        "Inbound webhook subscription not found",
      );
    }
    if (subscription.disabled) {
      throw new MymeError(
        ErrorCode.INBOUND_WEBHOOK_DISABLED,
        "Inbound webhook subscription is disabled",
      );
    }

    if (!isVerificationMethod(subscription.verification_method)) {
      // Defensive — the column was validated at write time, but if the
      // DB drifts (manual edit, post-restore corruption) we surface
      // 401 rather than crash.
      throw new MymeError(
        ErrorCode.INBOUND_WEBHOOK_VERIFICATION_FAILED,
        `Unknown verification method: ${subscription.verification_method}`,
      );
    }

    // Read the raw body as a Buffer — HMAC over altered bytes fails,
    // so any framework re-serialisation MUST NOT happen between the
    // bytes-on-the-wire and the verifier input.
    const rawBody = Buffer.from(await c.req.raw.arrayBuffer());

    let secret: string;
    try {
      secret = decryptSecret(
        subscription.secret_encrypted,
        SECRET_INFO.inboundWebhookSecret,
      );
    } catch {
      // Decryption failure is corruption / wrong MYME_AUTH_SECRET. The
      // sender shouldn't see the internals; surface as an opaque
      // verification failure (and let operators see the audit row).
      throw new MymeError(
        ErrorCode.INBOUND_WEBHOOK_VERIFICATION_FAILED,
        "Verification subsystem error",
      );
    }

    const adapter = ADAPTERS[subscription.verification_method];
    const result = adapter(rawBody, c.req.raw.headers, secret);

    const now = new Date().toISOString();
    // Fall back to the row id when the adapter doesn't surface a
    // delivery id — for first delivery this is unique; on a retry the
    // sender should reach again with the same external id (and that
    // adapter would surface it).
    const externalDeliveryId = result.external_delivery_id ?? generateId();

    const written = await storage.inboundWebhookEvents.insert({
      id: generateId(),
      inbound_webhook_id: id,
      external_delivery_id: externalDeliveryId,
      received_at: now,
      payload: rawBody.toString("utf8"),
      verified: result.verified,
      processing_error: result.verified ? undefined : result.reason,
    });

    if (!result.verified) {
      throw new MymeError(
        ErrorCode.INBOUND_WEBHOOK_VERIFICATION_FAILED,
        result.reason ?? "Signature verification failed",
      );
    }

    // 200 ack on verified receipt — fresh OR duplicate (idempotent).
    void storage.audit.log({
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
