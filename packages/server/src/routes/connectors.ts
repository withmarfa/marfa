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
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../page-limits.js";

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
    /** The key's source, the name its writes carry. */
    source: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    registered_at: z.string(),
    updated_at: z.string(),
    last_heartbeat_at: z.string().nullable(),
    last_run: ConnectorRunSchema.nullable(),
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

const IdParam = z.object({
  id: z.string().describe("A connector's `id`, as `GET /connectors` lists it."),
});

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

const ownKeyResponses = {
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
    "Registers the key this request carries as a connector, with a name and a description, and answers `201`. The key is the identity, one registration per key: the same key registering again updates the name and the description and answers `200` with the same `id`. A session token an app holds is not a key and is refused `403 forbidden`: it is renewed on every refresh, and a registration keyed to one would be orphaned by the next. Nothing runs here; a registration is a name for a process outside the server that heartbeats and reports its runs.",
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
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Invalid registration",
    },
    ...anyKeyResponses,
    403: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
      description: "A session token, which is not a key",
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
    "Every registration, newest first, each with when it last heartbeated and its last run. Any key.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(ConnectorSchema) }),
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
    "Removes the registration and every run it reported. The connector's own key or the operator key; another key is refused `403 forbidden`.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.literal(true) }) },
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
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Invalid run",
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
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(ConnectorRunSchema) }),
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function connectorRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  async function connectorOrRefuse(id: string) {
    const connector = await storage.connectors.get(id);
    if (!connector) {
      throw new MarfaError(
        ErrorCode.CONNECTOR_NOT_FOUND,
        "Connector not found",
      );
    }
    return connector;
  }

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
    return c.json({ data: await storage.connectors.list() }, 200);
  });

  router.openapi(getConnectorRoute, async (c) => {
    requireAuth(c);
    return c.json(await connectorOrRefuse(c.req.valid("param").id), 200);
  });

  router.openapi(deleteConnectorRoute, async (c) => {
    const key = requireAuth(c);
    const connector = await connectorOrRefuse(c.req.valid("param").id);
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
    const connector = await connectorOrRefuse(c.req.valid("param").id);
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
    const connector = await connectorOrRefuse(c.req.valid("param").id);
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
    const connector = await connectorOrRefuse(c.req.valid("param").id);
    const { limit } = c.req.valid("query");
    return c.json(
      { data: await storage.connectors.listRuns(connector.id, limit) },
      200,
    );
  });

  return router;
}

function requireOwnKey(ownerKeyId: string, keyId: string): void {
  if (ownerKeyId !== keyId) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Only the connector's own key may do this",
    );
  }
}
