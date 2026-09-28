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
import { requireAuth } from "../middleware/auth.js";
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
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../page-limits.js";
import { nullableRef, pageOf } from "./_schemas.js";
import { refuseUnknownQueryParams } from "./_unknown-query-keys.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OutcomeSchema = z.enum(["succeeded", "failed"]);

const ConnectorRunSchema = z
  .object({
    id: z.string(),
    connector_id: z.string(),
    outcome: OutcomeSchema,
    started_at: z.string(),
    finished_at: z.string(),
    summary: z.string().nullable(),
    error: z.string().nullable(),
    reported_at: z.string(),
  })
  .openapi("ConnectorRun");

const ConnectorSchema = z
  .object({
    id: z.string(),
    key_id: z.string(),
    /** The key's own source, which its writes carry unless they name a claim. */
    source: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    registered_at: z.string(),
    updated_at: z.string(),
    last_heartbeat_at: z.string().nullable(),
    last_run: nullableRef(ConnectorRunSchema),
    hold_expires_at: z
      .string()
      .nullable()
      .describe(
        "When the hold a process took at `POST /connectors/{id}/hold` lapses; `null` when no process holds the registration or its hold has lapsed.",
      ),
  })
  .openapi("Connector");

const RegisterSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const RunInputSchema = z.object({
  outcome: OutcomeSchema,
  started_at: z.string().refine(isValidTimestamp, "an ISO 8601 timestamp"),
  finished_at: z.string().refine(isValidTimestamp, "an ISO 8601 timestamp"),
  summary: z.string().max(2000).optional(),
  error: z.string().max(2000).optional(),
});

export const IdParam = z.object({
  id: z.string().describe("A connector's `id`, as `GET /connectors` lists it."),
});

const InboundEndpointSchema = z
  .object({
    id: z.string(),
    connector_id: z.string(),
    label: z.string().nullable(),
    duplicate_header: z
      .string()
      .nullable()
      .describe(
        "Lowercased. A delivery repeating this header's value is marked a repeat of the first that carried it.",
      ),
    path: z
      .string()
      .describe(
        "The address, under the instance's own: in full only in the answer that made it, redacted to its last four characters after.",
      ),
    created_at: z.string(),
    retired_at: z.string().nullable(),
  })
  .openapi("InboundEndpoint");

const EndpointInputSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  duplicate_header: z
    .string()
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/, "an HTTP header name")
    .optional()
    .describe(
      "A header whose value names a delivery, such as `X-GitHub-Delivery`: a delivery repeating a value is marked as a repeat, never dropped.",
    ),
});

const InboundOutcomeSchema = z.enum(["processed", "duplicate", "rejected"]);

const InboundDeliverySchema = z
  .object({
    id: z.string(),
    endpoint_id: z.string(),
    received_at: z.string(),
    method: z.string(),
    query: z.string(),
    headers: z
      .array(z.tuple([z.string(), z.string()]))
      .describe("`[name, value]` pairs in the order and case they arrived."),
    size: z.number().int(),
    sha256: z.string(),
    duplicate_of: z
      .object({ id: z.string(), outcome: InboundOutcomeSchema.nullable() })
      .nullable(),
    handled_at: z.string().nullable(),
    outcome: InboundOutcomeSchema.nullable(),
  })
  .openapi("InboundDelivery");

const EndpointParam = IdParam.extend({
  endpoint_id: z.string().describe("An endpoint's `id`."),
});

const DeliveryParam = IdParam.extend({
  delivery_id: z.string().describe("A delivery's `id`."),
});

const HandledInputSchema = z.object({
  ids: z.array(z.string()).min(1).max(MAX_PAGE_LIMIT),
  outcome: InboundOutcomeSchema,
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

const notFoundResponse = {
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["connector_not_found"]),
      },
    },
    description: "No such connector",
  },
};

export const ownKeyResponses = {
  ...anyKeyResponses,
  403: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
    },
    description: "Another key's registration",
  },
  ...notFoundResponse,
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const registerConnectorRoute = createRoute({
  operationId: "registerConnector",
  method: "post",
  path: "/",
  tags: ["Connectors"],
  summary: "Register the caller's key as a connector",
  description:
    "Registers the key this request carries as a connector, with a name and a description, and answers `201`. The key is the identity, one registration per key: the same key registering again updates the name and the description and answers `200` with the same `id`. A session token an app holds is not a key and is refused `403 forbidden`: it is renewed on every refresh, and a registration keyed to one would be orphaned by the next. The operator key is refused `403 forbidden` too: it runs the instance and never acts as a connector. Nothing runs here; a registration is a name for a process outside the server that heartbeats and reports its runs.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: RegisterSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ConnectorSchema } },
      description: "The registration, updated",
    },
    201: {
      content: { "application/json": { schema: ConnectorSchema } },
      description: "The registration",
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
        "`missing_required_field` for a body without `name`; `validation_error` for any other invalid registration",
    },
    ...anyKeyResponses,
    403: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
      description: "A session token, which is not a key, or the operator key",
    },
  },
});

const listConnectorsRoute = createRoute({
  operationId: "listConnectors",
  method: "get",
  path: "/",
  tags: ["Connectors"],
  summary: "List the registered connectors",
  description:
    "Every registration, newest first, each with when it last heartbeated, its last run, and until when a process holds it. Any key.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(ConnectorSchema, "ConnectorPage"),
        },
      },
      description: "The registrations",
    },
    ...anyKeyResponses,
  },
});

const getConnectorRoute = createRoute({
  operationId: "getConnector",
  method: "get",
  path: "/{id}",
  tags: ["Connectors"],
  summary: "Get one registered connector",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: ConnectorSchema } },
      description: "The registration",
    },
    ...anyKeyResponses,
    ...notFoundResponse,
  },
});

const deleteConnectorRoute = createRoute({
  operationId: "deleteConnector",
  method: "delete",
  path: "/{id}",
  tags: ["Connectors"],
  summary: "Remove a registration and its runs",
  description:
    "Removes the registration, every run it reported, its hold, and its inbound webhook endpoints with every delivery they stored. The state and the agreements it kept stay with its source, for a later key with the same source. The connector's own key or the operator key; another key is refused `403 forbidden`.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description: "Removed",
    },
    ...ownKeyResponses,
  },
});

const heartbeatRoute = createRoute({
  operationId: "heartbeatConnector",
  method: "post",
  path: "/{id}/heartbeat",
  tags: ["Connectors"],
  summary: "Record that the connector is alive",
  description:
    "Stamps `last_heartbeat_at` with the server's clock. The connector's own key only. What a stale heartbeat means is the reader's to decide: nothing here supervises.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ last_heartbeat_at: z.string() }),
        },
      },
      description: "The stamp",
    },
    ...ownKeyResponses,
  },
});

const reportRunRoute = createRoute({
  operationId: "reportConnectorRun",
  method: "post",
  path: "/{id}/runs",
  tags: ["Connectors"],
  summary: "Report a run and its outcome",
  description:
    "Records one run: `succeeded` or `failed`, when it started and finished, and a summary or an error. The connector's own key only. The server keeps the last hundred runs per connector and drops the oldest beyond that.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: RunInputSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ConnectorRunSchema } },
      description: "The run",
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
        "`missing_required_field` for a body without `outcome`, `started_at` or `finished_at`; `validation_error` for any other invalid run",
    },
    ...ownKeyResponses,
  },
});

const listRunsRoute = createRoute({
  operationId: "listConnectorRuns",
  method: "get",
  path: "/{id}/runs",
  tags: ["Connectors"],
  summary: "List a connector's runs",
  description: "Newest first. Any key.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .default(DEFAULT_PAGE_LIMIT)
        .describe(
          `How many runs, newest first: at most ${String(MAX_PAGE_LIMIT)}, ${String(DEFAULT_PAGE_LIMIT)} unless given.`,
        ),
      cursor: z
        .string()
        .optional()
        .describe("Opaque cursor from a previous page's `next_cursor`."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(ConnectorRunSchema, "ConnectorRunPage"),
        },
      },
      description: "The runs",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "A `limit` outside its bounds",
    },
    ...anyKeyResponses,
    ...notFoundResponse,
  },
});

export const validationResponse = {
  400: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["validation_error"]),
      },
    },
    description: "An invalid body or query",
  },
};

const createEndpointRoute = createRoute({
  operationId: "createInboundEndpoint",
  method: "post",
  path: "/{id}/endpoints",
  tags: ["Connectors"],
  summary: "Make an inbound webhook endpoint",
  description: `Makes an address a sender posts to without a credential, and answers it in full this once; later reads show its last four characters. The connector's own key or the operator key. A registration holds at most ${String(MAX_LIVE_ENDPOINTS)} live endpoints, and one more is refused \`409 conflict\`.`,
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
      description: "The endpoint, its address in full",
    },
    ...validationResponse,
    ...ownKeyResponses,
    409: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["conflict"]) },
      },
      description: "The registration holds as many live endpoints as it may",
    },
  },
});

const listEndpointsRoute = createRoute({
  operationId: "listInboundEndpoints",
  method: "get",
  path: "/{id}/endpoints",
  tags: ["Connectors"],
  summary: "List a connector's inbound webhook endpoints",
  description:
    "Newest first, retired ones included, each address redacted. The connector's own key or the operator key.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(InboundEndpointSchema, "InboundEndpointPage"),
        },
      },
      description: "The endpoints",
    },
    ...ownKeyResponses,
  },
});

const retireEndpointRoute = createRoute({
  operationId: "retireInboundEndpoint",
  method: "delete",
  path: "/{id}/endpoints/{endpoint_id}",
  tags: ["Connectors"],
  summary: "Retire an inbound webhook endpoint",
  description:
    "Its address answers `404` from now on, and it stays listed with `retired_at`. Deliveries it already stored stay readable until they age out. The connector's own key or the operator key.",
  security: [{ bearerAuth: [] }],
  request: { params: EndpointParam },
  responses: {
    200: {
      content: { "application/json": { schema: InboundEndpointSchema } },
      description: "The endpoint, retired",
    },
    ...anyKeyResponses,
    403: ownKeyResponses[403],
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "connector_not_found",
            "endpoint_not_found",
          ]),
        },
      },
      description: "No such connector, or no such endpoint on it",
    },
  },
});

const listDeliveriesRoute = createRoute({
  operationId: "listInboundDeliveries",
  method: "get",
  path: "/{id}/deliveries",
  tags: ["Connectors"],
  summary: "List a connector's inbound deliveries",
  description:
    "Oldest first, the ones not yet handled unless `state` says otherwise, without their bodies. The connector's own key only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      state: z
        .enum(["pending", "handled", "any"])
        .default("pending")
        .describe("Which deliveries: not yet handled, handled, or both."),
      endpoint_id: z
        .string()
        .optional()
        .describe("Only the deliveries this endpoint received."),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .default(DEFAULT_PAGE_LIMIT)
        .describe(
          `How many deliveries, oldest first: at most ${String(MAX_PAGE_LIMIT)}, ${String(DEFAULT_PAGE_LIMIT)} unless given.`,
        ),
      cursor: z
        .string()
        .optional()
        .describe("Opaque cursor from a previous page's `next_cursor`."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(InboundDeliverySchema, "InboundDeliveryPage"),
        },
      },
      description: "The deliveries",
    },
    ...validationResponse,
    ...ownKeyResponses,
  },
});

const deliveryBodyRoute = createRoute({
  operationId: "getInboundDeliveryBody",
  method: "get",
  path: "/{id}/deliveries/{delivery_id}/body",
  tags: ["Connectors"],
  summary: "Read an inbound delivery's body",
  description:
    "The bytes exactly as they arrived, as `application/octet-stream` whatever the sender declared. The connector's own key only.",
  security: [{ bearerAuth: [] }],
  request: { params: DeliveryParam },
  responses: {
    200: {
      content: {
        "application/octet-stream": {
          schema: { type: "string" as const, format: "binary" as const },
        },
      },
      description: "The body",
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
      description: "No such connector, or no such delivery on it",
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
    "Marks each delivery `processed`, `duplicate` or `rejected` and answers them in the order named. The first mark stands, so a repeat answers it again. An id that is not this connector's refuses the whole request and marks nothing. The connector's own key only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: HandledInputSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(InboundDeliverySchema) }),
        },
      },
      description: "The deliveries, marked",
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
        "`missing_required_field` for a body without `ids` or `outcome`; `validation_error` for any other invalid body",
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
      description: "No such connector, or a delivery it does not hold",
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
    // A session token's synthetic key is the token row, renewed on every
    // refresh: a registration keyed to it would be orphaned by the next.
    if (c.get("authType") === "oauth") {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "A connector registers under a key, not under an app's session token",
      );
    }
    if (key.is_operator === true) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "The operator key runs the instance and does not register as a connector",
      );
    }
    const body = c.req.valid("json");
    const { connector, created } = await storage.connectors.register(
      { id: key.id, source: key.source },
      body.name,
      body.description ?? null,
    );
    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: key.id,
      action: "connector.register",
      resource_type: "connector",
      resource_id: connector.id,
      details: { name: connector.name, created },
    });
    return c.json(connector, created ? 201 : 200);
  });

  router.openapi(listConnectorsRoute, async (c) => {
    requireAuth(c);
    return c.json(
      { data: await storage.connectors.list(), next_cursor: null },
      200,
    );
  });

  router.openapi(getConnectorRoute, async (c) => {
    requireAuth(c);
    return c.json(
      await connectorOrRefuse(storage, c.req.valid("param").id),
      200,
    );
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
    if (!(await storage.connectors.remove(connector.id))) {
      throw new MarfaError(
        ErrorCode.CONNECTOR_NOT_FOUND,
        "Connector not found",
      );
    }
    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: key.id,
      action: "connector.delete",
      resource_type: "connector",
      resource_id: connector.id,
      details: { name: connector.name },
    });
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
    const body = c.req.valid("json");
    if (Date.parse(body.finished_at) < Date.parse(body.started_at)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "A run cannot finish before it started",
      );
    }
    const run = await storage.connectors.recordRun(connector.id, body);
    return c.json(run, 201);
  });

  router.openapi(listRunsRoute, async (c) => {
    requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    refuseUnknownQueryParams(c.req.raw.url, listRunsRoute.request.query);
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
    const body = c.req.valid("json");
    const token = mintInboundToken();
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
    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: key.id,
      action: "inbound_endpoint.create",
      resource_type: "inbound_endpoint",
      resource_id: endpoint.id,
      details: { connector_id: connector.id, label: endpoint.label },
    });
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
    const retired = await storage.inbound.retireEndpoint(
      connector.id,
      endpoint_id,
    );
    if (retired === null) {
      throw new MarfaError(ErrorCode.ENDPOINT_NOT_FOUND, "Endpoint not found");
    }
    if (retired.retired) {
      await storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        key_id: key.id,
        action: "inbound_endpoint.retire",
        resource_type: "inbound_endpoint",
        resource_id: retired.endpoint.id,
        details: { connector_id: connector.id },
      });
    }
    return c.json(endpointView(retired.endpoint), 200);
  });

  router.openapi(listDeliveriesRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(storage, c.req.valid("param").id);
    requireOwnKey(connector.key_id, key.id);
    refuseUnknownQueryParams(c.req.raw.url, listDeliveriesRoute.request.query);
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
