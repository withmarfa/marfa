import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { createRoute, z } from "@hono/zod-openapi";
import { pageOf } from "./_schemas.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageLimit,
  pageCursor,
} from "../page-limits.js";
import {
  minStringLength,
  MarfaError,
  ErrorCode,
  WEBHOOK_DELIVERY_STATUSES,
  isValidTypePattern,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, standingPermission } from "../middleware/auth.js";
import type {
  Storage,
  StoredWebhook,
  WebhookOwner,
} from "../storage/interface.js";
import { refuseWebhookUrl } from "../webhooks/outbound-http.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { DELIVERY_CANCELED, ownerCredential } from "../webhooks/delivery.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";

/** One stream-style item pattern; absence on PATCH preserves configuration. */
function normalizeTypeFilter(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw.trim() === "") return null;
  const filter = raw.trim();
  if (filter === "*" || !isValidTypePattern(filter))
    throw malformedTypeIdentifier("type_filter", "Invalid type filter");
  return filter;
}

/** Redact secret to last 4 characters for list/get responses. */
function redactSecret(secret: string): string {
  if (secret.length <= 4) return secret;
  return "****" + secret.slice(-4);
}

/** The shortest signing secret a subscription takes. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

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
 * **`*` is not a member.** It was offered here and accepted at registration,
 * and dispatch matches a stored name against an event's own literally, so a
 * wildcard subscription received nothing and recorded no delivery while a
 * named one on the same event did. A subscription that can never fire is
 * worse than a refused request: the caller believes it is subscribed. Every
 * name here is one dispatch can match, which is what makes this list a
 * vocabulary rather than a menu.
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

const WebhookSchema = z
  .object({
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
  })
  .openapi("Webhook");

const DeliverySchema = z
  .object({
    id: z.string(),
    status: z.enum(WEBHOOK_DELIVERY_STATUSES),
    webhook_id: z.string(),
    event_type: z.string(),
    status_code: z.number().nullable(),
    attempt: z
      .number()
      .describe(
        "Cumulative accepted-outcome ordinal, not a census of concurrent or lost HTTP sends.",
      ),
    succeeded: z.boolean(),
    error: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("WebhookDelivery");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/** Every webhook door takes `webhooks.manage`. */
const managesWebhooks = standingPermission("webhooks.manage");

const createWebhookRoute = createRoute({
  operationId: "createWebhook",
  method: "post",
  path: "/",
  tags: ["Webhooks"],
  summary: "Create a webhook",
  description:
    "Registers an outbound webhook subscription targeting a URL and one or more event types from the closed vocabulary. The subscription belongs to the credential that registers it, which for a signed-in app is its grant rather than the token: each delivery carries only what that credential may read when it is sent, and the subscription is deleted when the key or the app's grant is revoked, while a key that expires or no longer holds `webhooks.manage` delivers nothing more. The URL must be `http` or `https` and reach a public address. The `secret` is the HMAC-SHA256 signing key, at least 32 characters, generated server-side when omitted, and returned in plaintext only on creation.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().min(1, "url is required"),
            events: z
              .array(EventNameSchema)
              .min(1, "events must be a non-empty array"),
            type_filter: z
              .string()
              .nullish()
              .describe(
                "One trimmed item subtree pattern. Blank or null clears the filter; qualified wildcards and unregistered identifiers are accepted. Global * and comma-separated alternatives are refused. Edges are independent of this item filter.",
              ),
            secret: minStringLength(
              z.string(),
              MIN_WEBHOOK_SECRET_LENGTH,
              `secret must be at least ${String(MIN_WEBHOOK_SECRET_LENGTH)} characters`,
            ).optional(),
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "The credential does not hold `webhooks.manage`.",
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
    "Returns the outbound webhook subscriptions that belong to this credential. Secrets are redacted here; the plaintext is only returned at create time.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(WebhookSchema, "WebhookPage"),
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
        "The credential does not hold `webhooks.manage`. Reading the webhook configuration takes the same permission as registering one.",
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
  middleware: managesWebhooks,
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
        "The credential does not hold `webhooks.manage`. Reading the webhook configuration takes the same permission as registering one.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: "Webhook not found, or registered by another credential",
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
    "Updates mutable fields on an outbound webhook subscription; the body is a partial, so unsupplied fields keep their existing values. Pointing it at another URL or turning it off settles its pending deliveries unsent. The signing secret cannot be rotated here; delete the subscription and create a new one.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
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
            type_filter: z
              .string()
              .nullish()
              .describe(
                "One trimmed item subtree pattern. Blank or null clears the filter; qualified wildcards and unregistered identifiers are accepted. Global * and comma-separated alternatives are refused. Edges are independent of this item filter.",
              ),
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "The credential does not hold `webhooks.manage`.",
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
    "Removes the subscription so no new deliveries are queued, and its pending deliveries are settled unsent rather than retried.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "The credential does not hold `webhooks.manage`.",
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

const redeliverRoute = createRoute({
  operationId: "redeliverWebhookDelivery",
  method: "post",
  path: "/{id}/deliveries/{delivery_id}/redeliver",
  tags: ["Webhooks"],
  summary: "Redeliver a failed delivery",
  description:
    "Queues one retained failed delivery using the current subscription address and secret. Stable delivery and event identity are preserved. The cumulative attempt ordinal counts accepted outcomes, not every concurrent or lost HTTP send.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: { params: z.object({ id: z.string(), delivery_id: z.string() }) },
  responses: {
    202: {
      description: "Delivery queued",
      content: { "application/json": { schema: DeliverySchema } },
    },
    403: {
      description: "The credential does not hold webhooks.manage.",
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
    },
    404: {
      description: "Webhook not found",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
    },
    409: {
      description: "Delivery cannot be redelivered",
      content: {
        "application/json": { schema: makeErrorResponseSchema(["conflict"]) },
      },
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
    "Returns recent delivery rows for one subscription, newest first, with the last accepted outcome and cumulative accepted-outcome ordinal. This is not a census of concurrent or lost HTTP sends.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    params: z.object({
      id: z.string().describe("Id of the webhook whose deliveries to list."),
    }),
    query: z.object({
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(DeliverySchema, "WebhookDeliveryPage"),
        },
      },
      description: "List of delivery rows",
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
        "The credential does not hold `webhooks.manage`. Reading the webhook configuration takes the same permission as registering one.",
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
 * The owner a subscription this caller registers belongs to: the key itself,
 * or for a signed-in app its grant, so that every token of the grant is the
 * same owner and the subscription outlives the token that registered it.
 */
function callerOwner(c: Context<AppEnv>): WebhookOwner {
  const key = requireAuth(c);
  if (c.get("authType") !== "oauth") return { kind: "key", keyId: key.id };
  const grant = c.get("oauthGrant");
  // Every grant this server issues has a person behind it; a token without
  // one names no grant a subscription could belong to.
  if (!grant?.authUserId) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "This sign-in names no grant a subscription could belong to",
    );
  }
  return {
    kind: "grant",
    clientId: grant.clientId,
    authUserId: grant.authUserId,
  };
}

function isOwner(c: Context<AppEnv>, owner: WebhookOwner): boolean {
  const key = requireAuth(c);
  if (c.get("authType") !== "oauth") {
    return owner.kind === "key" && owner.keyId === key.id;
  }
  const grant = c.get("oauthGrant");
  return (
    owner.kind === "grant" &&
    owner.clientId === grant?.clientId &&
    owner.authUserId === grant.authUserId
  );
}

/**
 * The subscription `id` as this caller may act on it, or `webhook_not_found`.
 *
 * **A subscription belongs to the credential that registered it**, and one
 * registered by another credential answers as an id nobody holds: listing,
 * reading, re-pointing or removing another credential's subscription would
 * let one credential send another's events to an address of its choosing,
 * or silence them.
 */
async function ownedWebhook(
  storage: Storage,
  c: Context<AppEnv>,
  id: string,
): Promise<StoredWebhook> {
  const webhook = await storage.outboundWebhooks.get(id);
  if (webhook && isOwner(c, webhook.owner)) return webhook;
  throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
}

/** A subscription as the wire carries it: no owner, secret redacted. */
function wireWebhook(webhook: StoredWebhook, revealSecret = false) {
  const {
    id,
    url,
    secret,
    events,
    type_filter,
    active,
    created_at,
    updated_at,
  } = webhook;
  const wire = {
    id,
    url,
    secret,
    events,
    type_filter,
    active,
    created_at,
    updated_at,
  };
  return revealSecret ? wire : { ...wire, secret: redactSecret(wire.secret) };
}

function assertUrlAccepted(url: string, allowPrivateAddresses: boolean): void {
  const refusal = refuseWebhookUrl(url, allowPrivateAddresses);
  if (refusal !== null) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, refusal);
  }
}

export function webhookRoutes(
  storage: Storage,
  options: { allowPrivateAddresses: boolean },
) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createWebhookRoute, async (c) => {
    requireAuth(c);
    const body = c.req.valid("json");
    assertUrlAccepted(body.url, options.allowPrivateAddresses);

    const webhook = await runAuditedTransaction(
      storage,
      () =>
        storage.outboundWebhooks.create({
          url: body.url,
          events: body.events,
          type_filter: normalizeTypeFilter(body.type_filter) ?? undefined,
          secret: body.secret,
          owner: callerOwner(c),
        }),
      (webhook) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "webhook.create",
        resource_type: "webhook",
        resource_id: webhook.id,
      }),
    );
    return c.json(wireWebhook(webhook, true), 201);
  });

  router.openapi(listWebhooksRoute, async (c) => {
    requireAuth(c);
    const webhooks = await storage.outboundWebhooks.list();
    return c.json(
      {
        data: webhooks
          .filter((w) => isOwner(c, w.owner))
          .map((w) => wireWebhook(w)),
        next_cursor: null,
      },
      200,
    );
  });

  router.openapi(getWebhookRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const webhook = await ownedWebhook(storage, c, id);
    return c.json(wireWebhook(webhook), 200);
  });

  router.openapi(updateWebhookRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    if (body.url !== undefined) {
      assertUrlAccepted(body.url, options.allowPrivateAddresses);
    }

    const updated = await runAuditedTransaction(
      storage,
      async () => {
        const existing = await ownedWebhook(storage, c, id);
        const next = await storage.outboundWebhooks.update(id, {
          url: body.url,
          events: body.events,
          type_filter: normalizeTypeFilter(body.type_filter),
          active: body.active,
        });
        if (next.url !== existing.url) {
          await storage.outboundWebhookDeliveries.cancelPending(
            id,
            DELIVERY_CANCELED.repointed,
          );
        } else if (!next.active) {
          await storage.outboundWebhookDeliveries.cancelPending(
            id,
            DELIVERY_CANCELED.inactive,
          );
        }
        return next;
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "webhook.update",
        resource_type: "webhook",
        resource_id: id,
      },
    );
    return c.json(wireWebhook(updated), 200);
  });

  router.openapi(deleteWebhookRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");

    await runAuditedTransaction(
      storage,
      async () => {
        await ownedWebhook(storage, c, id);
        await storage.outboundWebhooks.delete(id);
        await storage.outboundWebhookDeliveries.cancelPending(
          id,
          DELIVERY_CANCELED.removed,
        );
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "webhook.delete",
        resource_type: "webhook",
        resource_id: id,
      },
    );
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(listDeliveriesRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");

    await ownedWebhook(storage, c, id);

    return c.json(
      await storage.outboundWebhookDeliveries.list(id, { limit, cursor }),
      200,
    );
  });

  router.openapi(redeliverRoute, async (c) => {
    requireAuth(c);
    const { id, delivery_id } = c.req.valid("param");
    const delivery = await runAuditedTransaction(
      storage,
      async () => {
        const subscription = await ownedWebhook(storage, c, id);
        const existing = await storage.outboundWebhookDeliveries.get(
          id,
          delivery_id,
        );
        if (!existing)
          throw new MarfaError(
            ErrorCode.WEBHOOK_NOT_FOUND,
            "Webhook not found",
          );
        if (
          !subscription.active ||
          !(await ownerCredential(storage, subscription.owner))
        )
          throw new MarfaError(
            ErrorCode.CONFLICT,
            "Delivery cannot be redelivered",
          );
        const config = await readInstanceConfig(storage.settings);
        const retention =
          config?.audit_retention_days ?? c.get("config").auditRetentionDays;
        const now = new Date();
        const reopened = await storage.outboundWebhookDeliveries.reopen(
          id,
          delivery_id,
          subscription.url,
          now.toISOString(),
          retention > 0
            ? new Date(now.getTime() - retention * 86400000).toISOString()
            : null,
        );
        if (!reopened)
          throw new MarfaError(
            ErrorCode.CONFLICT,
            "Delivery cannot be redelivered",
          );
        return reopened;
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: requireAuth(c).id,
        action: "webhook.delivery.redeliver",
        resource_type: "webhook_delivery",
        resource_id: delivery_id,
        details: { webhook_id: id },
      },
    );
    return c.json(delivery, 202);
  });
  return router;
}
