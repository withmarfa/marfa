import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireTenantAdmin } from "../middleware/auth.js";
import { enforceQuota } from "../middleware/quota.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";

/** Redact secret to last 4 characters for list/get responses. */
function redactSecret(secret: string): string {
  if (secret.length <= 4) return secret;
  return "****" + secret.slice(-4);
}

const VALID_EVENTS = new Set([
  "item.created",
  "item.updated",
  "item.deleted",
  "item.restored",
  "item.state_changed",
  "metadata.changed",
  "edge.created",
  "edge.deleted",
  "*",
]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const WebhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  type_filter: z.string().nullable().optional(),
  secret: z.string(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const DeliverySchema = z.object({
  id: z.string(),
  webhook_id: z.string(),
  event: z.string(),
  status_code: z.number().nullable(),
  attempt: z.number(),
  succeeded: z.boolean(),
  error: z.string().nullable(),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createWebhookRoute = createRoute({
  operationId: "createWebhook",
  method: "post",
  path: "/",
  tags: ["Webhooks"],
  summary: "Create a webhook",
  description:
    "Registers an outbound webhook subscription targeting a URL and one or more event names (wildcards accepted). The `secret` is the HMAC-SHA256 signing key, generated server-side when omitted, and returned in plaintext only on creation.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().min(1, "url is required"),
            events: z
              .array(z.string())
              .min(1, "events must be a non-empty array"),
            type_filter: z.string().nullish(),
            secret: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: WebhookSchema,
        },
      },
      description: "Webhook created",
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
      description: "Validation error",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

const listWebhooksRoute = createRoute({
  operationId: "listWebhooks",
  method: "get",
  path: "/",
  tags: ["Webhooks"],
  summary: "List webhooks",
  description:
    "Returns every outbound webhook subscription in the caller's tenant. Secrets are redacted here — the plaintext is only returned at create time.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            webhooks: z.array(WebhookSchema),
          }),
        },
      },
      description: "List of webhooks (secrets redacted)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

const getWebhookRoute = createRoute({
  operationId: "getWebhook",
  method: "get",
  path: "/{id}",
  tags: ["Webhooks"],
  summary: "Get a webhook",
  description:
    "Returns one outbound webhook subscription by id, with its secret redacted.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Id of the webhook to fetch."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: WebhookSchema,
        },
      },
      description: "Webhook details (secret redacted)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: "Webhook not found",
    },
  },
});

const updateWebhookRoute = createRoute({
  operationId: "updateWebhook",
  method: "patch",
  path: "/{id}",
  tags: ["Webhooks"],
  summary: "Update a webhook",
  description:
    "Updates mutable fields on an outbound webhook subscription; the body is a partial, so unsupplied fields keep their existing values. The signing secret cannot be rotated here — delete the subscription and create a new one.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Id of the webhook to update."),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().optional(),
            events: z.array(z.string()).min(1).optional(),
            type_filter: z.string().nullish(),
            active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: WebhookSchema,
        },
      },
      description: "Updated webhook (secret redacted)",
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
      description: "Validation error",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: "Webhook not found",
    },
  },
});

const deleteWebhookRoute = createRoute({
  operationId: "deleteWebhook",
  method: "delete",
  path: "/{id}",
  tags: ["Webhooks"],
  summary: "Delete a webhook",
  description:
    "Removes the subscription so no new deliveries are queued. Deliveries already queued still fire and retry on the standard schedule, and delivery history is retained until the audit retention window expires.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Id of the webhook to delete."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OkResponseSchema,
        },
      },
      description: "Webhook deleted",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: "Webhook not found",
    },
  },
});

const listDeliveriesRoute = createRoute({
  operationId: "listWebhookDeliveries",
  method: "get",
  path: "/{id}/deliveries",
  tags: ["Webhooks"],
  summary: "List webhook deliveries",
  description:
    "Returns recent delivery attempts for one subscription, newest first, with each attempt's response status, attempt count, and next retry time. Use to debug delivery failures.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Id of the webhook whose deliveries to list."),
    }),
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of delivery attempts to return."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            deliveries: z.array(DeliverySchema),
          }),
        },
      },
      description: "List of delivery attempts",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: "Webhook not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function webhookRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createWebhookRoute, async (c) => {
    // tenant_admin only. Storage filters by key.tenant_id, so cross-tenant
    // attempts return WEBHOOK_NOT_FOUND rather than 403.
    const key = requireTenantAdmin(c);

    await enforceQuota(c, storage, "webhooks");

    const body = c.req.valid("json");

    try {
      new URL(body.url);
    } catch {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "url must be a valid URL",
      );
    }

    for (const event of body.events) {
      if (!VALID_EVENTS.has(event)) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Invalid event type "${event}". Valid types: ${[...VALID_EVENTS].join(", ")}`,
        );
      }
    }

    const webhook = await storage.outboundWebhooks.create(
      {
        url: body.url,
        events: body.events,
        type_filter: body.type_filter ?? undefined,
        secret: body.secret ?? undefined,
      },
      key.tenant_id,
    );

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "webhook.create",
      resource_type: "webhook",
      resource_id: webhook.id,
    });
    return c.json(webhook, 201);
  });

  router.openapi(listWebhooksRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const webhooks = await storage.outboundWebhooks.list(key.tenant_id);
    return c.json(
      {
        webhooks: webhooks.map((w) => ({
          ...w,
          secret: redactSecret(w.secret),
        })),
      },
      200,
    );
  });

  router.openapi(getWebhookRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const { id } = c.req.valid("param");
    const webhook = await storage.outboundWebhooks.get(id, key.tenant_id);
    if (!webhook) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }
    return c.json({ ...webhook, secret: redactSecret(webhook.secret) }, 200);
  });

  router.openapi(updateWebhookRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const existing = await storage.outboundWebhooks.get(id, key.tenant_id);
    if (!existing) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    if (body.url !== undefined) {
      try {
        new URL(body.url);
      } catch {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          "url must be a valid URL",
        );
      }
    }

    if (body.events !== undefined) {
      for (const event of body.events) {
        if (!VALID_EVENTS.has(event)) {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `Invalid event type: ${event}`,
          );
        }
      }
    }

    const updated = await storage.outboundWebhooks.update(id, {
      url: body.url,
      events: body.events,
      type_filter: body.type_filter,
      active: body.active,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "webhook.update",
      resource_type: "webhook",
      resource_id: id,
    });
    return c.json({ ...updated, secret: redactSecret(updated.secret) }, 200);
  });

  router.openapi(deleteWebhookRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const { id } = c.req.valid("param");

    const existing = await storage.outboundWebhooks.get(id, key.tenant_id);
    if (!existing) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    await storage.outboundWebhooks.delete(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "webhook.delete",
      resource_type: "webhook",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(listDeliveriesRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const { id } = c.req.valid("param");
    const { limit } = c.req.valid("query");

    const existing = await storage.outboundWebhooks.get(id, key.tenant_id);
    if (!existing) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    const deliveries = await storage.outboundWebhookDeliveries.list(id, limit);
    return c.json({ deliveries }, 200);
  });

  return router;
}
