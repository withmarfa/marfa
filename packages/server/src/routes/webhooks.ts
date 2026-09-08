import { createRoute, z } from "@hono/zod-openapi";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../page-limits.js";
import { MarfaError, ErrorCode, GLOBAL_TYPE_WILDCARD } from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  computeTypeFilter,
  requireSpacePermission,
  requireAuth,
} from "../middleware/auth.js";
import { reserveQuota } from "../middleware/quota.js";
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

/**
 * Every event an outbound webhook may subscribe to.
 *
 * **The one statement of the vocabulary, and the specification is generated
 * from it rather than describing it separately.** It was a `Set` here and
 * `z.array(z.string())` in the schema, so the constraint was real, enforced,
 * and invisible: a generated client got `string`, an editor offered no
 * completion, and the only way to learn a valid name was to send a wrong one
 * and read the 400. A specification that accepts any string where the runtime
 * accepts ten is wrong rather than incomplete.
 *
 * Restating the list in the schema would have fixed that and reintroduced the
 * drift one layer along, which is why `EventNameSchema` derives from this
 * rather than repeating it.
 *
 * `*` is a member: it is the subscribe-to-everything wildcard, and a caller
 * needs to see it offered as much as any named event.
 */
export const WEBHOOK_EVENTS = [
  "item.created",
  "item.updated",
  "item.deleted",
  "item.restored",
  "item.purged",
  "item.state_changed",
  "metadata.changed",
  "edge.created",
  "edge.updated",
  "edge.deleted",
  "*",
] as const;

/**
 * The vocabulary as the request schemas see it, which is what puts the names
 * in `openapi.json`.
 *
 * This replaced two hand-written validation loops rather than joining them.
 * They threw a `validation_error` naming the offending value, and so does
 * this — through the router's `defaultHook`, with the field path and the
 * permitted values in `details.errors` instead of interpolated into a
 * sentence. Structured rather than prose, and the two loops had drifted into
 * saying different things anyway: one listed the valid types and the other
 * did not.
 */
const EventNameSchema = z.enum(WEBHOOK_EVENTS);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const WebhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  // Deliberately `string`, where the request side is the enum.
  //
  // A stored row holds whatever was valid when it was written, and typing
  // the read side to today's vocabulary would assert something the database
  // cannot guarantee: retire an event and every row that subscribed to it
  // becomes a response the specification says is impossible. The constraint
  // belongs on the way in, which is where it is enforced.
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
              .array(EventNameSchema)
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "forbidden",
            "scoped_credential_not_permitted",
          ]),
        },
      },
      description:
        "`forbidden`: the credential does not hold `space.webhooks`. `scoped_credential_not_permitted`: it does, but its content read is narrower than the space. A subscription is space-level and carries no credential of its own, so a delivery cannot be narrowed to what its creator could read; only a credential that can read the whole space may register or re-point one.",
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
    "Returns every outbound webhook subscription in the caller's space. Secrets are redacted here — the plaintext is only returned at create time.",
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description:
        "The credential does not hold `space.webhooks`. Reading a space's webhook configuration takes the same permission as registering one.",
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description:
        "The credential does not hold `space.webhooks`. Reading a space's webhook configuration takes the same permission as registering one.",
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
            events: z.array(EventNameSchema).min(1).optional(),
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "forbidden",
            "scoped_credential_not_permitted",
          ]),
        },
      },
      description:
        "`forbidden`: the credential does not hold `space.webhooks`. `scoped_credential_not_permitted`: it does, but its content read is narrower than the space. A subscription is space-level and carries no credential of its own, so a delivery cannot be narrowed to what its creator could read; only a credential that can read the whole space may register or re-point one.",
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "forbidden",
            "scoped_credential_not_permitted",
          ]),
        },
      },
      description:
        "`forbidden`: the credential does not hold `space.webhooks`. `scoped_credential_not_permitted`: it does, but its content read is narrower than the space. A subscription is space-level and carries no credential of its own, so a delivery cannot be narrowed to what its creator could read; only a credential that can read the whole space may create, re-point or destroy one.",
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
        .max(MAX_PAGE_LIMIT)
        .optional()
        .default(DEFAULT_PAGE_LIMIT)
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description:
        "The credential does not hold `space.webhooks`. Reading a space's webhook configuration takes the same permission as registering one.",
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

/**
 * Refuse a credential whose reach is narrower than the space.
 *
 * A webhook subscription is space-level and carries no credential of its own:
 * the row stores a url, a secret, an event list and a space, and deliveries
 * are built once and sent to every matching endpoint. So there is no principal
 * to narrow a payload against, and the only way the delivery can be bounded is
 * for the subscription to belong to a credential that already reaches
 * everything in the space.
 *
 * **`space.webhooks` alone does not give that**, and under one permission
 * model that is clearer than it was rather than less true. A credential can
 * hold the permission to set up webhooks and hold read on one type, and the
 * subscription it registers would then deliver every type — a standing
 * subscription carrying more than its own credential could ever fetch, with
 * nothing on the row to say so. The two are separate axes and holding one says
 * nothing about the other.
 *
 * The test is the credential's own content reach: the global read wildcard
 * present in what it may reach, with nothing subtracted from it. Nothing about
 * how the credential was minted enters into it, so a key and a sign-in are
 * asked the same question and answered the same way.
 *
 * Every write door is guarded, not only registration. `PATCH` re-points the
 * url and rewrites the event list, which is registering a different
 * subscription on a row that already exists; `DELETE` destroys one the
 * credential could not have created, silencing deliveries the space depends
 * on. The message names all three so it stays true wherever it is returned.
 *
 * Refused rather than filtered, because filtering needs a principal the row
 * does not have.
 */
function refuseNarrowCredential(key: ApiKey): void {
  // `allowed === undefined` means "no credential at all" and nothing else, so
  // it cannot be the test: every authenticated caller arrives with a real
  // list. The question is whether that list reaches every type, which is the
  // global wildcard present and nothing subtracted from it.
  const filter = computeTypeFilter(key, "read");
  const reachesEverything =
    filter.allowed !== undefined &&
    filter.allowed.includes(GLOBAL_TYPE_WILDCARD) &&
    filter.excluded.length === 0;
  if (reachesEverything) return;
  throw new MarfaError(
    ErrorCode.SCOPED_CREDENTIAL_NOT_PERMITTED,
    "A webhook subscription sends everything in the space to its endpoint, and this credential cannot read everything in the space. Registering, re-pointing or removing one takes a credential that can.",
  );
}

export function webhookRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createWebhookRoute, async (c) => {
    // `space.webhooks` only. Storage filters by key.space_id, so cross-space
    // attempts return WEBHOOK_NOT_FOUND rather than 403.
    const key = requireAuth(c);
    requireSpacePermission(c, "space.webhooks");
    refuseNarrowCredential(key);

    // Reserved around the create below rather than checked here, so
    // concurrent creates cannot each see room against the same pre-write
    // count.
    const body = c.req.valid("json");

    try {
      new URL(body.url);
    } catch {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "url must be a valid URL",
      );
    }

    const webhook = await storage.runInTransaction(async () => {
      await reserveQuota(c, storage, [{ resource: "webhooks", increment: 1 }]);
      return storage.outboundWebhooks.create(
        {
          url: body.url,
          events: body.events,
          type_filter: body.type_filter ?? undefined,
          secret: body.secret ?? undefined,
        },
        key.space_id,
      );
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "webhook.create",
      resource_type: "webhook",
      resource_id: webhook.id,
    });
    return c.json(webhook, 201);
  });

  router.openapi(listWebhooksRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "space.webhooks");
    const webhooks = await storage.outboundWebhooks.list(key.space_id);
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
    const key = requireAuth(c);
    requireSpacePermission(c, "space.webhooks");
    const { id } = c.req.valid("param");
    const webhook = await storage.outboundWebhooks.get(id, key.space_id);
    if (!webhook) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }
    return c.json({ ...webhook, secret: redactSecret(webhook.secret) }, 200);
  });

  router.openapi(updateWebhookRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "space.webhooks");
    // The update door too: it re-points `url` and rewrites `events`, so
    // admitting a scoped credential here would let it take over a
    // subscription it could not have created.
    refuseNarrowCredential(key);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const existing = await storage.outboundWebhooks.get(id, key.space_id);
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

    const updated = await storage.outboundWebhooks.update(id, {
      url: body.url,
      events: body.events,
      type_filter: body.type_filter,
      active: body.active,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "webhook.update",
      resource_type: "webhook",
      resource_id: id,
    });
    return c.json({ ...updated, secret: redactSecret(updated.secret) }, 200);
  });

  router.openapi(deleteWebhookRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "space.webhooks");
    // Destroying a subscription this credential could not have created is
    // the same rationale as refusing to create one: the row belongs to
    // the space, not to the grant, and an app holding a subset of the
    // space must not be able to silence deliveries the space depends on.
    refuseNarrowCredential(key);
    const { id } = c.req.valid("param");

    const existing = await storage.outboundWebhooks.get(id, key.space_id);
    if (!existing) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    await storage.outboundWebhooks.delete(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "webhook.delete",
      resource_type: "webhook",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(listDeliveriesRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "space.webhooks");
    const { id } = c.req.valid("param");
    const { limit } = c.req.valid("query");

    const existing = await storage.outboundWebhooks.get(id, key.space_id);
    if (!existing) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }

    const deliveries = await storage.outboundWebhookDeliveries.list(id, limit);
    return c.json({ deliveries }, 200);
  });

  return router;
}
