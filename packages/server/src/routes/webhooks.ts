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
import {
  authorityId,
  isDirectAuthority,
  requireRecentOwnerAuthentication,
  requireAuth,
  standingPermission,
} from "../middleware/auth.js";
import type {
  Storage,
  StoredWebhook,
  WebhookOwner,
} from "../storage/interface.js";
import {
  refuseNonPublicHost,
  refuseWebhookUrl,
} from "../webhooks/outbound-http.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { WIRE_EVENT_NAMES, type WireEventName } from "../pubsub.js";
import {
  DELIVERY_CANCELED,
  ownerCredential,
  subscriptionSelects,
} from "../webhooks/delivery.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import * as clock from "../clock.js";
import {
  isWebhookMaker,
  listReadableWebhooks,
  readableWebhook,
  readWebhookDeliveries,
  webhookMaker,
} from "../webhooks/read.js";

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
 * **Derived from the events the bus carries, so no copy of the list is kept
 * here, and the specification is generated from it rather than describing it
 * separately.** A generated client gets the names as an enum and an editor
 * offers them, instead of a bare `string` that is learned by sending a wrong
 * one and reading the 400. `EventNameSchema` derives from this list rather
 * than repeating it.
 *
 * **`*` is not a member.** It was offered here and accepted at registration,
 * and dispatch matches a stored name against an event's own literally, so a
 * wildcard subscription received nothing and recorded no delivery while a
 * named one on the same event did. A subscription that can never fire is
 * worse than a refused request: the caller believes it is subscribed. Every
 * name here is one dispatch can match, which is what makes this list a
 * vocabulary rather than a menu.
 */
export const WEBHOOK_EVENTS = Object.values(WIRE_EVENT_NAMES) as [
  WireEventName,
  ...WireEventName[],
];

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
  "The URL Marfa posts events to: `http` or `https`, with no user name or password. Unless the instance allows private addresses, it must reach a public address: Marfa refuses a URL whose host resolves to a private one, and checks again at each delivery.";
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

const WebhookReadSchema = WebhookSchema.extend({
  maker: z
    .object({
      kind: z
        .enum(["key", "app"])
        .describe("Whether a key or an app registered the webhook."),
      id: z.string().describe("The key ID or OAuth client ID."),
      name: z
        .string()
        .nullable()
        .describe(
          "The maker's current name, or null if it is no longer available.",
        ),
    })
    .describe("The credential that registered this webhook."),
}).openapi("WebhookRead");

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
          schema: z.strictObject({
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
      description: `- \`validation_error\`: ${INVALID_FIELD}; \`secret\` is too short; or \`type_filter\` is \`*\`, malformed or a list; or the body has a field this endpoint doesn't take.\n- \`missing_required_field\`: \`url\` or \`events\` is missing.`,
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
    "Returns webhooks and their makers, with secrets redacted. The owner's browser session and local command see every subscription; keys and apps see only their own.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(
            WebhookReadSchema,
            "WebhookPage",
            "webhook you can inspect",
          ),
        },
      },
      description: "Returns the webhooks you can inspect.",
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
    "Returns a webhook and its maker, with its secret redacted. The owner's browser session and local command can read any subscription; keys and apps can read only their own.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    params: z.object({ id: WEBHOOK_ID }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: WebhookReadSchema,
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
    "Updates a webhook and returns it. Fields you leave out keep their values. Marfa cancels a pending delivery if you change `url`, set `active` to `false`, or change `events` or `type_filter` to exclude it. To change the secret, create a new webhook.",
  security: [{ bearerAuth: [] }],
  middleware: managesWebhooks,
  request: {
    params: z.object({ id: WEBHOOK_ID }),
    body: {
      content: {
        "application/json": {
          schema: z.strictObject({
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
      description: `- \`validation_error\`: ${INVALID_FIELD}; or \`type_filter\` is \`*\`, malformed or a list; or the body has a field this endpoint doesn't take.`,
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

/** Why a redelivery is refused, in `details.reason` and in words. */
function redeliveryRefused(reason: string, message: string): MarfaError {
  return new MarfaError(ErrorCode.CONFLICT, message, { reason });
}

const redeliverRoute = createRoute({
  operationId: "redeliverWebhookDelivery",
  method: "post",
  path: "/{id}/deliveries/{delivery_id}/redeliver",
  tags: ["Webhooks"],
  summary: "Redeliver a webhook delivery",
  description:
    "Redelivers a failed delivery, queuing it again at the current URL. The owner's recently authenticated browser session or local command can retry any subscription; keys and apps can retry only their own.",
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
        "Returns the delivery as `pending`, keeping its ID. Marfa makes up to 8 more attempts. Its `status_code`, `error` and `attempt` keep their values until the next attempt records an outcome.",
      content: { "application/json": { schema: DeliverySchema } },
    },
    403: {
      description:
        MANAGE_REFUSAL +
        " An owner browser must have signed in within five minutes.",
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
        "- `conflict`: Marfa can't send it again. `details.reason` is the first that applies: `webhook_inactive`; `credential_unavailable`, the registering key or app is gone or lacks `webhooks.manage`; `delivery_not_failed`; `delivery_expired`, past audit retention; or `delivery_not_retained`, its event is no longer held.",
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
    "Returns delivery metadata without event payloads, newest first. The owner's browser session and local command can inspect any subscription; keys and apps can inspect only their own.",
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
      description:
        "Returns a page of deliveries. Marfa deletes settled deliveries older than the instance's audit retention.",
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
  // Authentication sets the grant with the oauth auth type, and refuses a
  // sign-in naming no person before it gets here.
  if (!grant) throw new Error("An oauth request carries its grant");
  return {
    kind: "grant",
    clientId: grant.clientId,
    authUserId: grant.authUserId,
  };
}

/** Subscription changes remain exclusive to the registering credential. */
async function ownedWebhook(
  storage: Storage,
  c: Context<AppEnv>,
  id: string,
): Promise<StoredWebhook> {
  const webhook = await storage.outboundWebhooks.get(id);
  if (webhook && isWebhookMaker(c, webhook.owner)) return webhook;
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

async function assertUrlAccepted(
  url: string,
  allowPrivateAddresses: boolean,
): Promise<void> {
  const refusal =
    refuseWebhookUrl(url, allowPrivateAddresses) ??
    (allowPrivateAddresses ? null : await refuseNonPublicHost(url));
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
    await assertUrlAccepted(body.url, options.allowPrivateAddresses);

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
    const webhooks = await listReadableWebhooks(storage, c);
    return c.json(
      {
        data: await Promise.all(
          webhooks.map(async (w) => ({
            ...wireWebhook(w),
            maker: await webhookMaker(storage, w.owner),
          })),
        ),
        next_cursor: null,
      },
      200,
    );
  });

  router.openapi(getWebhookRoute, async (c) => {
    const webhook = await readableWebhook(storage, c, c.req.valid("param").id);
    return c.json(
      {
        ...wireWebhook(webhook),
        maker: await webhookMaker(storage, webhook.owner),
      },
      200,
    );
  });

  router.openapi(updateWebhookRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    if (body.url !== undefined) {
      await assertUrlAccepted(body.url, options.allowPrivateAddresses);
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
        } else {
          await storage.outboundWebhookDeliveries.cancelUnselected(
            id,
            (eventType, frame) => subscriptionSelects(next, eventType, frame),
            DELIVERY_CANCELED.unselected,
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
    const { id } = c.req.valid("param");
    return c.json(
      await readWebhookDeliveries(storage, c, id, c.req.valid("query")),
      200,
    );
  });

  router.openapi(redeliverRoute, async (c) => {
    if (isDirectAuthority(c)) requireRecentOwnerAuthentication(c);
    else requireAuth(c);
    const { id, delivery_id } = c.req.valid("param");
    const delivery = await runAuditedTransaction(
      storage,
      async () => {
        const subscription = await readableWebhook(storage, c, id);
        const existing = await storage.outboundWebhookDeliveries.get(
          id,
          delivery_id,
        );
        if (!existing)
          throw new MarfaError(
            ErrorCode.WEBHOOK_NOT_FOUND,
            "Webhook not found",
          );
        if (!subscription.active)
          throw redeliveryRefused(
            "webhook_inactive",
            "The webhook is turned off. Turn it on, then redeliver.",
          );
        if (!(await ownerCredential(storage, subscription.owner)))
          throw redeliveryRefused(
            "credential_unavailable",
            "The key or app that registered this webhook has been revoked, has expired or no longer has webhooks.manage, so Marfa sends it nothing.",
          );
        const config = await readInstanceConfig(storage.settings);
        const retention =
          config?.audit_retention_days ?? c.get("config").auditRetentionDays;
        const now = clock.now();
        const cutoff =
          retention > 0
            ? new Date(now.getTime() - retention * 86400000).toISOString()
            : null;
        const reopened = await storage.outboundWebhookDeliveries.reopen(
          id,
          delivery_id,
          subscription.url,
          now.toISOString(),
          cutoff,
        );
        if (reopened) return reopened;
        // The transaction serializes this refusal with every other
        // redelivery, so `existing` is the state `reopen` found.
        if (existing.status !== "dead_letter")
          throw redeliveryRefused(
            "delivery_not_failed",
            `The delivery's status is ${existing.status}. Only a delivery Marfa gave up on, with status dead_letter, can be redelivered.`,
          );
        if (cutoff !== null && existing.created_at < cutoff)
          throw redeliveryRefused(
            "delivery_expired",
            "The delivery is older than the instance's audit retention, so it can't be redelivered.",
          );
        throw redeliveryRefused(
          "delivery_not_retained",
          "Marfa no longer holds this delivery's event in a form it can send, so it can't be redelivered.",
        );
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
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
