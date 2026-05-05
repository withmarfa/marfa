import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
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
  success: z.boolean(),
  error: z.string().nullable(),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createWebhookRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Webhooks"],
  summary: "Create a new webhook",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const listWebhooksRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Webhooks"],
  summary: "List all webhooks",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const getWebhookRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Webhooks"],
  summary: "Get a single webhook",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Webhook not found",
    },
  },
});

const updateWebhookRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Webhooks"],
  summary: "Partially update a webhook",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Webhook not found",
    },
  },
});

const deleteWebhookRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Webhooks"],
  summary: "Delete a webhook",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Webhook not found",
    },
  },
});

const listDeliveriesRoute = createRoute({
  method: "get",
  path: "/{id}/deliveries",
  tags: ["Webhooks"],
  summary: "List recent delivery attempts for a webhook",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Webhook not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function webhookRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /webhooks — create a new webhook
  router.openapi(createWebhookRoute, async (c) => {
    const key = requireAdmin(c);
    const body = c.req.valid("json");

    // URL validation beyond what Zod handles
    try {
      new URL(body.url);
    } catch {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "url must be a valid URL",
      );
    }

    // Validate event types against known set
    for (const event of body.events) {
      if (!VALID_EVENTS.has(event)) {
        throw new MymeError(
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

    // Return full secret on creation so the caller can store it
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

  // GET /webhooks — list all webhooks
  router.openapi(listWebhooksRoute, async (c) => {
    const key = requireAdmin(c);
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

  // GET /webhooks/:id — get a single webhook
  router.openapi(getWebhookRoute, async (c) => {
    const key = requireAdmin(c);
    const { id } = c.req.valid("param");
    const webhook = await storage.outboundWebhooks.get(id, key.tenant_id);
    if (!webhook) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }
    return c.json({ ...webhook, secret: redactSecret(webhook.secret) }, 200);
  });

  // PATCH /webhooks/:id — partial update
  router.openapi(updateWebhookRoute, async (c) => {
    const key = requireAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const existing = await storage.outboundWebhooks.get(id, key.tenant_id);
    if (!existing) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    // URL validation beyond what Zod handles
    if (body.url !== undefined) {
      try {
        new URL(body.url);
      } catch {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "url must be a valid URL",
        );
      }
    }

    // Validate event types against known set
    if (body.events !== undefined) {
      for (const event of body.events) {
        if (!VALID_EVENTS.has(event)) {
          throw new MymeError(
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

  // DELETE /webhooks/:id
  router.openapi(deleteWebhookRoute, async (c) => {
    const key = requireAdmin(c);
    const { id } = c.req.valid("param");

    const existing = await storage.outboundWebhooks.get(id, key.tenant_id);
    if (!existing) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
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

  // GET /webhooks/:id/deliveries — recent delivery attempts
  router.openapi(listDeliveriesRoute, async (c) => {
    const key = requireAdmin(c);
    const { id } = c.req.valid("param");
    const { limit } = c.req.valid("query");

    const existing = await storage.outboundWebhooks.get(id, key.tenant_id);
    if (!existing) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    const deliveries = await storage.outboundWebhookDeliveries.list(id, limit);
    return c.json({ deliveries }, 200);
  });

  return router;
}
