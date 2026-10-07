import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { createRoute, z } from "@hono/zod-openapi";
import { pageOf, wholeListOf } from "./_schemas.js";
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

const URL_TEXT =
  "The URL Marfa posts events to: `http` or `https`, with no user name or password. Unless the instance allows private addresses, it must reach a public address, which Marfa checks again at each delivery.";
const EVENTS_TEXT = "The events to send. Name each one: there's no wildcard.";
const TYPE_FILTER_TEXT =
  "Send item events only for this type and its subtypes, such as `core.media`, or for every type a pattern such as `app.*` matches. The type needn't be registered. Edge events aren't filtered.";

const WebhookSchema = z
  .object({
    id: z.string().describe("Unique identifier for the webhook."),
    url: z.string().describe("The URL Marfa posts events to."),
    // Deliberately `string`, where the request side is the enum.
    //
    // A stored row holds whatever was valid when it was written, and typing
    // the read side to today's vocabulary would assert something the database
    // cannot guarantee: retire an event and every row that subscribed to it
    // becomes a response the specification says is impossible. The constraint
    // belongs on the way in, which is where it is enforced.
    events: z
      .array(z.string())
      .describe("The events Marfa sends, such as `item.created`."),
    type_filter: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The type, with its subtypes, or the pattern whose item events Marfa sends. Absent when Marfa sends item events of every type. Edge events aren't filtered.",
      ),
    secret: z
      .string()
      .describe(
        "The key Marfa signs each delivery with. Only `POST /webhooks` returns it whole; other responses show `****` and its last four characters.",
      ),
    active: z
      .boolean()
      .describe("`true` if Marfa sends events to the webhook."),
    created_at: z.string().describe("When the webhook was created, in UTC."),
    updated_at: z.string().describe("When the webhook last changed, in UTC."),
  })
  .openapi("Webhook", {
    description:
      "A webhook sends the events you choose, as you can read them, to a URL.",
  });

const DeliverySchema = z
  .object({
    id: z
      .string()
      .describe(
        "Unique identifier for the delivery. Marfa sends it as `delivery_id`, the same on every attempt.",
      ),
    status: z
      .enum(WEBHOOK_DELIVERY_STATUSES)
      .describe(
        "`pending`: waiting to be sent or retried. `success`: the receiver answered with a `2xx` status. `dead_letter`: Marfa gave up, and you can redeliver it. `canceled`: Marfa settled it unsent, and `error` says why.",
      ),
    webhook_id: z
      .string()
      .describe("The ID of the webhook the delivery belongs to."),
    event_type: z
      .string()
      .describe("The event delivered, such as `item.created`."),
    status_code: z
      .number()
      .nullable()
      .describe(
        "The HTTP status the receiver answered on the latest recorded attempt, or `null` if that attempt got no answer or no attempt has run.",
      ),
    attempt: z
      .number()
      .describe(
        "How many attempts have recorded an outcome, across every redelivery. A send whose outcome was lost, such as during a restart, isn't counted, so the receiver may have seen more.",
      ),
    succeeded: z.boolean().describe("`true` if `status` is `success`."),
    error: z
      .string()
      .nullable()
      .describe(
        "Why the latest attempt failed, or why Marfa settled the delivery unsent. `null` after a success or before the first attempt.",
      ),
    created_at: z.string().describe("When Marfa queued the delivery, in UTC."),
  })
  .openapi("WebhookDelivery", {
    description:
      "A delivery is one event Marfa sends, or tries to send, to a webhook's URL.",
  });

/** The refusal every webhook door gives a credential without the permission. */
const MANAGE_REFUSAL = "- `forbidden`: you don't have `webhooks.manage`.";
const NOT_FOUND = "- `webhook_not_found`: no webhook of yours has this ID.";
const WEBHOOK_ID = z.string().describe("The ID of the webhook.");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/** Every webhook door takes `webhooks.manage`. */
const managesWebhooks = standingPermission("webhooks.manage");

const INVALID_FIELD =
  "a field is invalid. For example, `url` isn't `http` or `https`, carries a user name or password, or names an IP address that isn't public; `events` is empty or names an unknown event or `*`";

const createWebhookRoute = createRoute({
  operationId: "createWebhook",
  method: "post",
  path: "/",
  tags: ["Webhooks"],
  summary: "Create a webhook",
  description:
    "Creates a webhook that sends the events you name to `url`. It belongs to your key, or your app's grant: Marfa deletes it when that is revoked, and sends nothing while it lacks `webhooks.manage` or the key has expired.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().min(1, "url is required").describe(URL_TEXT),
            events: z
              .array(EventNameSchema)
              .min(1, "events must be a non-empty array")
              .describe(EVENTS_TEXT),
            type_filter: z
              .string()
              .nullish()
              .describe(
                `${TYPE_FILTER_TEXT} Leave it out, blank or \`null\` for every type.`,
              ),
            secret: minStringLength(
              z.string(),
              MIN_WEBHOOK_SECRET_LENGTH,
              `secret must be at least ${String(MIN_WEBHOOK_SECRET_LENGTH)} characters`,
            )
              .optional()
              .describe(
                "The key Marfa signs each delivery with. Leave it out for Marfa to generate one.",
              ),
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
      description:
        "Returns the new webhook with its whole `secret`, which no other response shows. Use it to check each delivery's `X-Marfa-Signature`.",
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
      description: `- \`validation_error\`: ${INVALID_FIELD}; \`secret\` is too short; or \`type_filter\` is \`*\`, malformed or a list.\n- \`missing_required_field\`: \`url\` or \`events\` is missing.`,
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
      description: MANAGE_REFUSAL,
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
    "Returns every webhook that belongs to you, with each `secret` shortened to its last four characters.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(WebhookSchema, "WebhookPage", "webhook you own"),
        },
      },
      description: "Returns your webhooks.",
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
      description: MANAGE_REFUSAL,
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
    "Returns a webhook, with its `secret` shortened to its last four characters.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    params: z.object({ id: WEBHOOK_ID }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: WebhookSchema,
        },
      },
      description: "Returns the webhook.",
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
      description: MANAGE_REFUSAL,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: NOT_FOUND,
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
    "Updates a webhook and returns it. Fields you leave out keep their values. Changing `url`, or setting `active` to `false`, cancels its pending deliveries. To change the secret, create a new webhook.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    params: z.object({ id: WEBHOOK_ID }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().optional().describe(URL_TEXT),
            events: z
              .array(EventNameSchema)
              .min(1)
              .optional()
              .describe(EVENTS_TEXT),
            type_filter: z
              .string()
              .nullish()
              .describe(`${TYPE_FILTER_TEXT} Blank or \`null\` removes it.`),
            active: z
              .boolean()
              .optional()
              .describe(
                "`false` stops sending events and cancels pending deliveries. `true` starts again.",
              ),
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
      description: "Returns the updated webhook.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: `- \`validation_error\`: ${INVALID_FIELD}; or \`type_filter\` is \`*\`, malformed or a list.`,
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
      description: MANAGE_REFUSAL,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: NOT_FOUND,
    },
  },
});

const deleteWebhookRoute = createRoute({
  operationId: "deleteWebhook",
  method: "delete",
  path: "/{id}",
  tags: ["Webhooks"],
  summary: "Delete a webhook",
  description: "Deletes a webhook and cancels its pending deliveries.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    params: z.object({ id: WEBHOOK_ID }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OkResponseSchema,
        },
      },
      description: "Returns `ok: true`.",
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
      description: MANAGE_REFUSAL,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: NOT_FOUND,
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
    "Sends a `dead_letter` delivery again, to the webhook's current `url`, and returns it as `pending`. The delivery keeps its ID, and Marfa makes up to 8 more attempts.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    params: z.object({
      id: WEBHOOK_ID,
      delivery_id: z.string().describe("The ID of the delivery."),
    }),
  },
  responses: {
    202: {
      description:
        "Returns the delivery as `pending`. Its `status_code`, `error` and `attempt` keep their values until the next attempt records an outcome.",
      content: { "application/json": { schema: DeliverySchema } },
    },
    403: {
      description: MANAGE_REFUSAL,
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
    },
    404: {
      description:
        "- `webhook_not_found`: no webhook of yours has this ID, or it has no delivery with this `delivery_id`.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
    },
    409: {
      description:
        "- `conflict`: the delivery isn't `dead_letter`, it's older than the instance's audit retention, or the webhook is turned off.",
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
    "Returns a page of a webhook's deliveries, newest first. Marfa deletes a delivery that isn't `pending` once it's older than the instance's audit retention.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    params: z.object({ id: WEBHOOK_ID }),
    query: z.object({
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(DeliverySchema, "WebhookDeliveryPage", {
            page: "A page of a webhook's deliveries, newest first.",
            data: "The deliveries, newest first.",
          }),
        },
      },
      description: "Returns a page of deliveries.",
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
      description: MANAGE_REFUSAL,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["webhook_not_found"]),
        },
      },
      description: NOT_FOUND,
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
    // Read before the subscription is looked up, so every refusal of the
    // body comes before the `404`, as the schema's own do.
    const typeFilter = normalizeTypeFilter(body.type_filter);

    const updated = await runAuditedTransaction(
      storage,
      async () => {
        const existing = await ownedWebhook(storage, c, id);
        const next = await storage.outboundWebhooks.update(id, {
          url: body.url,
          events: body.events,
          type_filter: typeFilter,
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
