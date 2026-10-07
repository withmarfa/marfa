import { maxStringLength } from "@withmarfa/shared";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
/**
 * /connectors: the smallest door a process outside the server needs. It
 * registers under the key it holds, heartbeats, and reports each run with
 * its outcome; the server lists what registered. No runtime, no
 * supervision, no manifests: a reader decides what a stale heartbeat or a
 * failed run means.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidTimestamp } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, standingRule } from "../middleware/auth.js";
import { normalizeTimeBound } from "../storage/interface.js";
import type { InboundEndpoint, Storage } from "../storage/interface.js";
import {
  INBOUND_PREFIX,
  hashInboundToken,
  mintInboundToken,
} from "../inbound/address.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageLimit,
  pageCursor,
} from "../page-limits.js";
import { nullableRef, pageOf, wholeListOf } from "./_schemas.js";
import { connectorsForReader } from "./_connector-reach.js";
import { refuseUnknownBodyKeys } from "./_unknown-body-keys.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OutcomeSchema = z
  .enum(["succeeded", "failed"])
  .describe("How the run ended: `succeeded` or `failed`.");

const ConnectorRunSchema = z
  .object({
    id: z.string().describe("Unique identifier for the run."),
    connector_id: z
      .string()
      .describe("The ID of the connector that reported the run."),
    outcome: OutcomeSchema,
    started_at: z.string().describe("When the run started, in UTC."),
    finished_at: z.string().describe("When the run finished, in UTC."),
    summary: z
      .string()
      .nullable()
      .describe("A short summary of the run; `null` if none was reported."),
    error: z
      .string()
      .nullable()
      .describe("The error the run reported; `null` if none was reported."),
    reported_at: z.string().describe("When Marfa recorded the run."),
  })
  .describe("A run a connector reported, with its outcome and times.")
  .openapi("ConnectorRun");

const ConnectorSchema = z
  .object({
    id: z.string().describe("Unique identifier for the connector."),
    key_id: z
      .string()
      .describe("The ID of the API key the connector registered under."),
    source: z
      .string()
      .describe(
        "The source of that key. The connector's state document and agreements belong to this source.",
      ),
    name: z.string().describe("The connector's name."),
    description: z
      .string()
      .nullable()
      .describe("What the connector does; `null` if none was given."),
    registered_at: z.string().describe("When the connector first registered."),
    updated_at: z
      .string()
      .describe("When the connector's name or description was last set."),
    last_heartbeat_at: z
      .string()
      .nullable()
      .describe("When the connector last sent a heartbeat; `null` if never."),
    last_run: nullableRef(ConnectorRunSchema).describe(
      "The connector's most recently reported run; `null` if it has reported none.",
    ),
    hold_expires_at: z
      .string()
      .nullable()
      .describe(
        "When the hold on the connector lapses; `null` if no process holds it or its hold has lapsed.",
      ),
  })
  .describe(
    "A connector is a process outside Marfa that registers under an API key, sends heartbeats and reports its runs.",
  )
  .openapi("Connector");

const RegisterSchema = z.object({
  name: maxStringLength(z.string().min(1), 200).describe(
    "The connector's name.",
  ),
  description: maxStringLength(z.string(), 2000)
    .optional()
    .describe(
      "What the connector does. Leave it out for none: registering again without it clears the old one.",
    ),
});

const RunInputSchema = z.object({
  outcome: OutcomeSchema,
  started_at: z
    .string()
    .refine(isValidTimestamp, "an ISO 8601 timestamp")
    .describe(
      "When the run started, as an ISO 8601 time. Marfa converts it to UTC. A time with no offset is read as UTC.",
    ),
  finished_at: z
    .string()
    .refine(isValidTimestamp, "an ISO 8601 timestamp")
    .describe(
      "When the run finished, as an ISO 8601 time. Marfa converts it to UTC. It can't be before `started_at`.",
    ),
  summary: maxStringLength(z.string(), 2000)
    .optional()
    .describe("A short summary of the run. Leave it out for none."),
  error: maxStringLength(z.string(), 2000)
    .optional()
    .describe("The error the run hit. Leave it out for none."),
});

export const IdParam = z.object({
  id: z.string().describe("The ID of the connector."),
});

const InboundEndpointSchema = z
  .object({
    id: z.string().describe("Unique identifier for the webhook endpoint."),
    connector_id: z
      .string()
      .describe("The ID of the connector the endpoint belongs to."),
    label: z
      .string()
      .nullable()
      .describe("A name for people to read; `null` if none was given."),
    duplicate_header: z
      .string()
      .nullable()
      .describe(
        "The header whose value identifies a delivery, lowercased; `null` if none was set. A delivery that repeats a value is marked as a repeat in `duplicate_of`.",
      ),
    path: z
      .string()
      .describe(
        "The address a sender posts to, a path on this instance. It is in full only in the response that created the endpoint; after that it shows `/inbound/****` and its last four characters.",
      ),
    created_at: z.string().describe("When the endpoint was created."),
    retired_at: z
      .string()
      .nullable()
      .describe("When the endpoint was retired; `null` while it is live."),
  })
  .describe(
    "A webhook endpoint is an address where a sender posts to a connector without a credential: the address is the credential.",
  )
  .openapi("InboundEndpoint");

const EndpointInputSchema = z.object({
  label: maxStringLength(z.string().min(1), 200)
    .optional()
    .describe("A name for people to read. Leave it out for none."),
  duplicate_header: z
    .string()
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/, "an HTTP header name")
    .optional()
    .describe(
      "A header whose value identifies a delivery, such as `X-GitHub-Delivery`. Marfa stores a delivery that repeats a value and marks it as a repeat. Leave it out to mark none.",
    ),
});

const InboundOutcomeSchema = z.enum(["processed", "duplicate", "rejected"]);

const InboundDeliverySchema = z
  .object({
    id: z.string().describe("Unique identifier for the delivery."),
    endpoint_id: z
      .string()
      .describe("The ID of the endpoint that received the delivery."),
    received_at: z.string().describe("When Marfa received the delivery."),
    method: z.string().describe("The HTTP method of the request."),
    query: z
      .string()
      .describe(
        "The query string as the sender sent it, without the `?`; empty if there was none.",
      ),
    headers: z
      .array(z.tuple([z.string(), z.string()]))
      .describe("`[name, value]` pairs in the order and case they arrived."),
    size: z.number().int().describe("The size of the body in bytes."),
    sha256: z.string().describe("The SHA-256 hash of the body, in hex."),
    duplicate_of: z
      .object({
        id: z.string().describe("The ID of the earlier delivery."),
        outcome: InboundOutcomeSchema.nullable().describe(
          "How the earlier delivery was handled; `null` if it is still pending.",
        ),
      })
      .nullable()
      .describe(
        "The earliest retained delivery on the same endpoint with the same `duplicate_header` value; `null` if this is the first with its value, the delivery lacks the header, or the endpoint sets none.",
      ),
    handled_at: z
      .string()
      .nullable()
      .describe("When the delivery was marked handled; `null` while pending."),
    outcome: InboundOutcomeSchema.nullable().describe(
      "How the connector handled the delivery: `processed`, `duplicate` or `rejected`; `null` while pending.",
    ),
  })
  .describe(
    "A delivery is one request that arrived at a webhook endpoint, stored as it came until the connector marks it handled.",
  )
  .openapi("InboundDelivery");

const EndpointParam = IdParam.extend({
  endpoint_id: z.string().describe("The ID of the webhook endpoint."),
});

const DeliveryParam = IdParam.extend({
  delivery_id: z.string().describe("The ID of the delivery."),
});

const HandledInputSchema = z.object({
  ids: z
    .array(z.string())
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .describe("The IDs of the deliveries to mark."),
  outcome: InboundOutcomeSchema.describe(
    "How the connector handled them: `processed`, `duplicate` or `rejected`. Marfa records it and acts on nothing.",
  ),
});

/** Live endpoints one registration may hold. */
export const MAX_LIVE_ENDPOINTS = 10;

const anyKeyResponses = {
  401: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(["unauthorized"]) },
    },
    description: "Unauthorized",
  },
};

const NOT_FOUND = "- `connector_not_found`: no connector has this ID.";

/** The 400 of a paged listing whose query takes filters. */
export const listQueryResponse = {
  400: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["validation_error"]),
      },
    },
    description:
      "- `validation_error`: a query parameter is unknown or invalid, or `cursor` is malformed or came from another listing.",
  },
};

const notFoundResponse = {
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["connector_not_found"]),
      },
    },
    description: NOT_FOUND,
  },
};

const hiddenConnectorResponse = {
  404: {
    ...notFoundResponse[404],
    description:
      "- `connector_not_found`: no connector has this ID, or it is registered under another key and yours isn't the operator key.",
  },
};

const forbiddenResponse = (description: string) => ({
  403: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
    },
    description,
  },
});

/** The doors only the connector's own key reaches. */
export const ownKeyResponses = {
  ...anyKeyResponses,
  ...forbiddenResponse(
    "- `forbidden`: your credential isn't the connector's own key. The operator key can't use this endpoint.",
  ),
  ...notFoundResponse,
};

/** The doors the operator key reaches too. */
export const ownKeyOrOperatorResponses = {
  ...anyKeyResponses,
  ...forbiddenResponse(
    "- `forbidden`: your credential is neither the connector's own key nor the operator key.",
  ),
  ...notFoundResponse,
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * A connector registers under a working key of its own. A session token's
 * synthetic key is the token row, renewed on every refresh, so a
 * registration keyed to it would be orphaned by the next; and the operator
 * key runs the instance rather than feeding it.
 */
const workingKeyOnly = standingRule("a working key", (c) => {
  const key = requireAuth(c);
  if (c.get("authType") === "oauth") {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "A connector registers under a key, not under an app's session token",
    );
  }
  if (key.is_operator) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "The operator key runs the instance and does not register as a connector",
    );
  }
});

const registerConnectorRoute = createRoute({
  operationId: "registerConnector",
  method: "post",
  path: "/",
  tags: ["Connectors"],
  summary: "Register a connector",
  description:
    "Registers your key as a connector, with a name and description, and returns it. Each key has one registration: registering again updates the name and description and returns the same `id`.",
  security: [{ bearerAuth: [] }],
  middleware: workingKeyOnly,
  request: {
    body: { content: { "application/json": { schema: RegisterSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ConnectorSchema } },
      description:
        "Returns the existing connector with its name and description updated. Its `id` and `registered_at` don't change.",
    },
    201: {
      content: { "application/json": { schema: ConnectorSchema } },
      description: "Returns the new connector.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "validation_error",
          ]),
        },
      },
      description:
        "- `missing_required_field`: `name` is missing.\n- `validation_error`: `name` isn't 1 to 200 characters, `description` is over 2,000 characters, or the body has a top-level field this endpoint doesn't take.",
    },
    ...anyKeyResponses,
    ...forbiddenResponse(
      "- `forbidden`: your credential is an app's session token, not a key, or the operator key, which runs the instance and can't register as a connector.",
    ),
  },
});

const listConnectorsRoute = createRoute({
  operationId: "listConnectors",
  method: "get",
  path: "/",
  tags: ["Connectors"],
  summary: "List connectors",
  description:
    "Returns your registration, or every registration if you use the operator key, newest first.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(
            ConnectorSchema,
            "ConnectorPage",
            "connector you can read",
          ),
        },
      },
      description: "Returns the connectors.",
    },
    ...anyKeyResponses,
  },
});

const getConnectorRoute = createRoute({
  operationId: "getConnector",
  method: "get",
  path: "/{id}",
  tags: ["Connectors"],
  summary: "Get a connector",
  description:
    "Returns a connector, with when it last sent a heartbeat, its last run and any hold on it.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: ConnectorSchema } },
      description: "Returns the connector.",
    },
    ...anyKeyResponses,
    ...hiddenConnectorResponse,
  },
});

const deleteConnectorRoute = createRoute({
  operationId: "deleteConnector",
  method: "delete",
  path: "/{id}",
  tags: ["Connectors"],
  summary: "Delete a connector",
  description:
    "Deletes the connector, its runs and hold, and its webhook endpoints with every delivery they stored. Its state document and agreements stay with its source, for a later key with the same source.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description: "Returns `ok: true`.",
    },
    ...ownKeyOrOperatorResponses,
  },
});

const heartbeatRoute = createRoute({
  operationId: "heartbeatConnector",
  method: "post",
  path: "/{id}/heartbeat",
  tags: ["Connectors"],
  summary: "Send a heartbeat",
  description:
    "Sets `last_heartbeat_at` to the current time and returns it. Marfa takes no action when heartbeats stop.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            last_heartbeat_at: z
              .string()
              .describe("When Marfa recorded the heartbeat."),
          }),
        },
      },
      description: "Returns the time Marfa recorded.",
    },
    ...ownKeyResponses,
  },
});

const reportRunRoute = createRoute({
  operationId: "reportConnectorRun",
  method: "post",
  path: "/{id}/runs",
  tags: ["Connectors"],
  summary: "Report a run",
  description:
    "Records one run of the connector, with its outcome and times, and returns it. Marfa keeps the last 100 runs and drops older ones.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: RunInputSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ConnectorRunSchema } },
      description: "Returns the run.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "validation_error",
          ]),
        },
      },
      description:
        "- `missing_required_field`: `outcome`, `started_at` or `finished_at` is missing.\n- `validation_error`: `outcome` isn't `succeeded` or `failed`, a time isn't a timestamp, `finished_at` is before `started_at`, `summary` or `error` is over 2,000 characters, or the body has a top-level field this endpoint doesn't take.",
    },
    ...ownKeyResponses,
  },
});

const listRunsRoute = createRoute({
  operationId: "listConnectorRuns",
  method: "get",
  path: "/{id}/runs",
  tags: ["Connectors"],
  summary: "List connector runs",
  description: "Returns the runs the connector reported, newest first.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(ConnectorRunSchema, "ConnectorRunPage", {
            page: "One page of a connector's runs.",
            data: "The runs, newest reported first.",
          }),
        },
      },
      description: "Returns a page of runs.",
    },
    ...listQueryResponse,
    ...anyKeyResponses,
    ...hiddenConnectorResponse,
  },
});

const createEndpointRoute = createRoute({
  operationId: "createInboundEndpoint",
  method: "post",
  path: "/{id}/endpoints",
  tags: ["Connectors"],
  summary: "Create a webhook endpoint",
  description:
    "Creates a webhook endpoint for the connector and returns it. Save its `path`: this is the only response that shows it in full.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: EndpointInputSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: InboundEndpointSchema } },
      description: "Returns the endpoint, with its full `path`.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "- `validation_error`: `label` isn't 1 to 200 characters, `duplicate_header` isn't a valid header name, or the body has a top-level field this endpoint doesn't take.",
    },
    ...ownKeyOrOperatorResponses,
    409: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["conflict"]) },
      },
      description: `- \`conflict\`: the connector already has ${String(MAX_LIVE_ENDPOINTS)} live endpoints. Retire one first.`,
    },
  },
});

const listEndpointsRoute = createRoute({
  operationId: "listInboundEndpoints",
  method: "get",
  path: "/{id}/endpoints",
  tags: ["Connectors"],
  summary: "List webhook endpoints",
  description:
    "Returns the connector's webhook endpoints, newest first, retired ones included.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(
            InboundEndpointSchema,
            "InboundEndpointPage",
            "webhook endpoint of the connector",
          ),
        },
      },
      description:
        "Returns the endpoints, each with its `path` redacted to its last four characters.",
    },
    ...ownKeyOrOperatorResponses,
  },
});

const retireEndpointRoute = createRoute({
  operationId: "retireInboundEndpoint",
  method: "delete",
  path: "/{id}/endpoints/{endpoint_id}",
  tags: ["Connectors"],
  summary: "Retire a webhook endpoint",
  description:
    "Retires a webhook endpoint, so its address stops accepting deliveries. It stays listed with `retired_at`, and deliveries it already stored stay readable until they age out.",
  security: [{ bearerAuth: [] }],
  request: { params: EndpointParam },
  responses: {
    200: {
      content: { "application/json": { schema: InboundEndpointSchema } },
      description:
        "Returns the endpoint with `retired_at` set. Retiring it again returns it unchanged.",
    },
    ...anyKeyResponses,
    403: ownKeyOrOperatorResponses[403],
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "connector_not_found",
            "endpoint_not_found",
          ]),
        },
      },
      description: `${NOT_FOUND}\n- \`endpoint_not_found\`: the connector has no endpoint with this ID.`,
    },
  },
});

const listDeliveriesRoute = createRoute({
  operationId: "listInboundDeliveries",
  method: "get",
  path: "/{id}/deliveries",
  tags: ["Connectors"],
  summary: "List inbound deliveries",
  description:
    "Returns the webhook deliveries the connector received, oldest first, without their bodies. Only those not yet handled, unless you set `state`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      state: z
        .enum(["pending", "handled", "any"])
        .default("pending")
        .describe(
          "Which deliveries to return: `pending` (not yet handled), `handled` or `any`.",
        ),
      endpoint_id: z
        .string()
        .optional()
        .describe("Only the deliveries this endpoint received."),
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(InboundDeliverySchema, "InboundDeliveryPage", {
            page: "One page of a connector's inbound deliveries.",
            data: "The deliveries, oldest first.",
          }),
        },
      },
      description: "Returns a page of deliveries.",
    },
    ...listQueryResponse,
    ...ownKeyResponses,
  },
});

const deliveryBodyRoute = createRoute({
  operationId: "getInboundDeliveryBody",
  method: "get",
  path: "/{id}/deliveries/{delivery_id}/body",
  tags: ["Connectors"],
  summary: "Get an inbound delivery's body",
  description:
    "Returns a delivery's body exactly as it arrived, as `application/octet-stream` whatever the sender declared.",
  security: [{ bearerAuth: [] }],
  request: { params: DeliveryParam },
  responses: {
    200: {
      content: {
        "application/octet-stream": {
          schema: { type: "string" as const, format: "binary" as const },
        },
      },
      description: "Returns the body.",
    },
    ...anyKeyResponses,
    403: ownKeyResponses[403],
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "connector_not_found",
            "delivery_not_found",
          ]),
        },
      },
      description: `${NOT_FOUND}\n- \`delivery_not_found\`: the connector has no delivery with this ID.`,
    },
  },
});

const markHandledRoute = createRoute({
  operationId: "markInboundDeliveriesHandled",
  method: "post",
  path: "/{id}/deliveries/handled",
  tags: ["Connectors"],
  summary: "Mark inbound deliveries handled",
  description:
    "Marks each named delivery handled, with an outcome, and returns them in the order you named. The first mark stands: marking a delivery again returns it unchanged.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: HandledInputSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z
              .array(InboundDeliverySchema)
              .describe(
                "The deliveries, each once, in the order you first named it.",
              ),
          }),
        },
      },
      description: "Returns the deliveries, marked.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "validation_error",
          ]),
        },
      },
      description:
        "- `missing_required_field`: `ids` or `outcome` is missing.\n- `validation_error`: `ids` is empty or has more than 200 IDs, `outcome` isn't `processed`, `duplicate` or `rejected`, or the body has a top-level field this endpoint doesn't take.",
    },
    ...anyKeyResponses,
    403: ownKeyResponses[403],
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "connector_not_found",
            "delivery_not_found",
          ]),
        },
      },
      description: `${NOT_FOUND}\n- \`delivery_not_found\`: an ID isn't one of this connector's deliveries. Nothing is marked.`,
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function connectorOrRefuse(storage: Storage, id: string) {
  const connector = await storage.connectors.get(id);
  if (!connector) {
    throw new MarfaError(ErrorCode.CONNECTOR_NOT_FOUND, "Connector not found");
  }
  return connector;
}

export function connectorRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(registerConnectorRoute, async (c) => {
    const key = requireAuth(c);
    refuseUnknownBodyKeys(await c.req.json(), RegisterSchema);
    const body = c.req.valid("json");
    const { connector, created } = await runAuditedTransaction(
      storage,
      () =>
        storage.connectors.register(
          { id: key.id, source: key.source },
          body.name,
          body.description ?? null,
        ),
      ({ connector, created }) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: key.id,
        action: "connector.register",
        resource_type: "connector",
        resource_id: connector.id,
        details: { name: connector.name, created },
      }),
    );
    return c.json(connector, created ? 201 : 200);
  });

  router.openapi(listConnectorsRoute, async (c) => {
    const reader = connectorsForReader(requireAuth(c), storage);
    return c.json({ data: await reader.list(), next_cursor: null }, 200);
  });

  router.openapi(getConnectorRoute, async (c) => {
    const reader = connectorsForReader(requireAuth(c), storage);
    return c.json(await reader.get(c.req.valid("param").id), 200);
  });

  router.openapi(deleteConnectorRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    if (connector.key_id !== key.id && !key.is_operator) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Only the connector's own key or the operator key removes a registration",
      );
    }
    // Two removals at once: the one whose statement deleted nothing answers
    // as if it had arrived after the other, and audits nothing.
    await runAuditedTransaction(
      storage,
      async () => {
        if (!(await storage.connectors.remove(connector.id))) {
          throw new MarfaError(
            ErrorCode.CONNECTOR_NOT_FOUND,
            "Connector not found",
          );
        }
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: key.id,
        action: "connector.delete",
        resource_type: "connector",
        resource_id: connector.id,
        details: { name: connector.name },
      },
    );
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(heartbeatRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    const at = await storage.connectors.heartbeat(connector.id);
    if (at === null) {
      throw new MarfaError(
        ErrorCode.CONNECTOR_NOT_FOUND,
        "Connector not found",
      );
    }
    return c.json({ last_heartbeat_at: at }, 200);
  });

  router.openapi(reportRunRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    refuseUnknownBodyKeys(await c.req.json(), RunInputSchema);
    const body = c.req.valid("json");
    const started_at = normalizeTimeBound(body.started_at, "started_at");
    const finished_at = normalizeTimeBound(body.finished_at, "finished_at");
    // Both are one fixed-width UTC spelling now, so text order is time order.
    if (finished_at < started_at) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "A run cannot finish before it started",
      );
    }
    const run = await storage.connectors.recordRun(connector.id, {
      ...body,
      started_at,
      finished_at,
    });
    return c.json(run, 201);
  });

  router.openapi(listRunsRoute, async (c) => {
    const reader = connectorsForReader(requireAuth(c), storage);
    const connector = await reader.get(c.req.valid("param").id);
    const { limit, cursor } = c.req.valid("query");
    return c.json(
      await storage.connectors.listRuns(connector.id, { limit, cursor }),
      200,
    );
  });

  router.openapi(createEndpointRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKeyOrOperator(connector.key_id, key);
    refuseUnknownBodyKeys(await c.req.json(), EndpointInputSchema);
    const body = c.req.valid("json");
    const token = mintInboundToken();
    const endpoint = await runAuditedTransaction(
      storage,
      async () => {
        const endpoint = await storage.inbound.createEndpoint(
          {
            connectorId: connector.id,
            tokenHash: hashInboundToken(token),
            tokenLast4: token.slice(-4),
            label: body.label ?? null,
            duplicateHeader: body.duplicate_header?.toLowerCase() ?? null,
          },
          MAX_LIVE_ENDPOINTS,
        );
        if (endpoint === "limit") {
          throw new MarfaError(
            ErrorCode.CONFLICT,
            `A connector holds at most ${String(MAX_LIVE_ENDPOINTS)} live endpoints; retire one first`,
          );
        }
        return endpoint;
      },
      (endpoint) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: key.id,
        action: "inbound_endpoint.create",
        resource_type: "inbound_endpoint",
        resource_id: endpoint.id,
        details: { connector_id: connector.id, label: endpoint.label },
      }),
    );
    return c.json(endpointView(endpoint, `${INBOUND_PREFIX}${token}`), 201);
  });

  router.openapi(listEndpointsRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKeyOrOperator(connector.key_id, key);
    const endpoints = await storage.inbound.listEndpoints(connector.id);
    return c.json(
      {
        data: endpoints.map((endpoint) => endpointView(endpoint)),
        next_cursor: null,
      },
      200,
    );
  });

  router.openapi(retireEndpointRoute, async (c) => {
    const key = requireAuth(c);
    const { id, endpoint_id } = c.req.valid("param");
    const connector = await connectorOrRefuse(storage, id);
    requireOwnKeyOrOperator(connector.key_id, key);
    const retired = await runAuditedTransaction(
      storage,
      async () => {
        const retired = await storage.inbound.retireEndpoint(
          connector.id,
          endpoint_id,
        );
        if (retired === null) {
          throw new MarfaError(
            ErrorCode.ENDPOINT_NOT_FOUND,
            "Endpoint not found",
          );
        }
        return retired;
      },
      (retired) =>
        retired.retired
          ? {
              client_ip: c.get("clientIp") ?? null,
              key_id: key.id,
              action: "inbound_endpoint.retire",
              resource_type: "inbound_endpoint",
              resource_id: retired.endpoint.id,
              details: { connector_id: connector.id },
            }
          : null,
    );
    return c.json(endpointView(retired.endpoint), 200);
  });

  router.openapi(listDeliveriesRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    const { state, endpoint_id, limit, cursor } = c.req.valid("query");
    return c.json(
      await storage.inbound.listDeliveries(
        connector.id,
        endpoint_id === undefined
          ? { state }
          : { state, endpointId: endpoint_id },
        { limit, cursor },
      ),
      200,
    );
  });

  router.openapi(deliveryBodyRoute, async (c) => {
    const key = requireAuth(c);
    const { id, delivery_id } = c.req.valid("param");
    const connector = await connectorOrRefuse(storage, id);
    requireOwnKey(connector.key_id, key.id);
    const body = await storage.inbound.body(connector.id, delivery_id);
    if (body === null) {
      throw new MarfaError(ErrorCode.DELIVERY_NOT_FOUND, "Delivery not found");
    }
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": "application/octet-stream",
    });
  });

  router.openapi(markHandledRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    refuseUnknownBodyKeys(await c.req.json(), HandledInputSchema);
    const { ids, outcome } = c.req.valid("json");
    const marked = await storage.inbound.markHandled(
      connector.id,
      ids,
      outcome,
    );
    if (marked === null) {
      throw new MarfaError(
        ErrorCode.DELIVERY_NOT_FOUND,
        "A delivery named is not this connector's; nothing was marked",
      );
    }
    return c.json({ data: marked }, 200);
  });

  return router;
}

function endpointView(endpoint: InboundEndpoint, path?: string) {
  return {
    id: endpoint.id,
    connector_id: endpoint.connector_id,
    label: endpoint.label,
    duplicate_header: endpoint.duplicate_header,
    path: path ?? `${INBOUND_PREFIX}****${endpoint.token_last4}`,
    created_at: endpoint.created_at,
    retired_at: endpoint.retired_at,
  };
}

export function requireOwnKeyOrOperator(
  ownerKeyId: string,
  key: { id: string; is_operator?: boolean },
): void {
  if (ownerKeyId !== key.id && key.is_operator !== true) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Only the connector's own key or the operator key may do this",
    );
  }
}

export function requireOwnKey(ownerKeyId: string, keyId: string): void {
  if (ownerKeyId !== keyId) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Only the connector's own key may do this",
    );
  }
}
