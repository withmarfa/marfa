import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireEdgePermission,
  requireTypeAccess,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import { assertEdgeCanBeCreated } from "../storage/edge-constraints.js";
import { publishEdge } from "../pubsub.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EdgeSchema = z.object({
  id: z.string(),
  space_id: z.string().nullable().optional(),
  source_id: z.string(),
  target_id: z.string(),
  edge_type: z.string(),
  properties: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

const EdgeListSchema = z.object({
  data: z.array(EdgeSchema),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
});

const MAX_EDGE_TYPE_FILTER = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseEdgeTypeFilter(
  raw: string | undefined,
): string | string[] | undefined {
  if (!raw) return undefined;
  if (!raw.includes(",")) return raw;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.length > MAX_EDGE_TYPE_FILTER) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Too many edge types in filter (max ${String(MAX_EDGE_TYPE_FILTER)})`,
    );
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listEdgesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listEdges",
  tags: ["Edges"],
  summary: "List edges",
  description:
    "Returns a paginated list of edges across the space, optionally filtered by edge type. Pass `edge_type` as a comma-separated list (up to 10 entries) to scope, or omit it to list every edge.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe(
          "Comma-separated edge types. Up to 10 entries. Omit to list every edge.",
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum edges to return per page."),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgeListSchema } },
      description: "Edges, paginated",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Validation error (e.g. too many edge types in filter)",
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

const createEdgeRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createEdge",
  tags: ["Edges"],
  summary: "Create an edge",
  description:
    "Creates a single typed edge between two existing items in the space. Writes are dual-gated, requiring write permission on both the source item's type and the edge type, and edge-type constraints and cycle rules are enforced at create time.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            source_id: z.string(),
            target_id: z.string(),
            edge_type: z.string(),
            properties: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: z.object({ edge: EdgeSchema }) },
      },
      description: "Edge created",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
            "edge_constraint_violation",
            "edge_cycle",
          ]),
        },
      },
      description: "Validation / constraint / cycle error",
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
          schema: makeErrorResponseSchema([
            "item_not_found",
            "edge_type_not_found",
          ]),
        },
      },
      description: "Source, target, or edge type not found",
    },
  },
});

const updateEdgeRoute = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "updateEdge",
  tags: ["Edges"],
  summary: "Update an edge",
  description:
    "Updates an edge's properties. The identity fields (edge type, source, and target) are immutable, so re-pointing an edge means deleting it and creating a new one.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Edge id.") }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            properties: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ edge: EdgeSchema }) },
      },
      description: "Edge updated",
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
      description: "Attempted to change immutable field",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_not_found"]),
        },
      },
      description: "Edge not found",
    },
  },
});

const deleteEdgeRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteEdge",
  tags: ["Edges"],
  summary: "Delete an edge",
  description:
    "Deletes a single edge by id. The edge type's `cascade_on_delete` setting decides what happens to the connected items: `cascade` deletes them, `orphan` leaves them, and `block` rejects the delete while endpoints remain.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().describe("Edge id.") }) },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Deleted",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_not_found"]),
        },
      },
      description: "Edge not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router (mounted at /edges)
// ---------------------------------------------------------------------------

export function edgeRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listEdgesRoute, async (c) => {
    requireAuth(c);
    const spaceId = c.get("apiKey")?.space_id;
    const q = c.req.valid("query");
    const result = await storage.edges.list({
      spaceId,
      edge_type: parseEdgeTypeFilter(q.edge_type),
      limit: q.limit,
      cursor: q.cursor,
    });
    return c.json(result, 200);
  });

  router.openapi(createEdgeRoute, async (c) => {
    requireAuth(c);
    const body = c.req.valid("json");
    if (!isValidId(body.source_id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid source_id");
    }
    if (!isValidId(body.target_id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid target_id");
    }
    const spaceId = c.get("apiKey")?.space_id;

    // Dual gate: source item's type permission + edge type permission.
    // Admin keys bypass both via the helpers.
    const sourceItem = await storage.items.get(body.source_id, spaceId);
    if (!sourceItem) {
      throw new MarfaError(
        ErrorCode.ITEM_NOT_FOUND,
        `Edge source item not found: ${body.source_id}`,
      );
    }
    requireTypeAccess(c, sourceItem.type, "write");
    requireEdgePermission(c, body.edge_type, "write");

    const edge = await storage.runInTransaction(async () => {
      await assertEdgeCanBeCreated(storage.edges, storage.items, {
        source_id: body.source_id,
        target_id: body.target_id,
        edge_type: body.edge_type,
        space_id: spaceId,
      });
      return storage.edges.createRaw(
        {
          source_id: body.source_id,
          target_id: body.target_id,
          edge_type: body.edge_type,
          properties: body.properties,
        },
        spaceId,
      );
    });
    await publishEdge({ type: "edge_created", edge, spaceId });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "edge.create",
      resource_type: "edge",
      resource_id: edge.id,
      details: {
        edge_type: edge.edge_type,
        source_id: edge.source_id,
        target_id: edge.target_id,
      },
    });
    return c.json({ edge }, 201);
  });

  router.openapi(updateEdgeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const spaceId = c.get("apiKey")?.space_id;
    const existing = await storage.edges.get(id);
    // `edges.get` is unscoped, so 404-cloak any edge outside the caller's
    // space: a space-scoped caller must never learn another space's edge
    // exists, let alone mutate it. Platform-admin / single-space keys carry
    // no space_id and skip the check.
    if (!existing || (spaceId && existing.space_id !== spaceId)) {
      throw new MarfaError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
    }
    // Use getIncludingTrashed so edges whose source item is trashed
    // still run the source-type permission check. A plain
    // storage.items.get() returns null for trashed sources, which would
    // silently skip the gate and let a credential without the source
    // type's write permission mutate the edge.
    const srcItem = await storage.items.getIncludingTrashed(
      existing.source_id,
      spaceId,
    );
    if (srcItem) requireTypeAccess(c, srcItem.type, "write");
    requireEdgePermission(c, existing.edge_type, "write");
    // Reject attempts to change immutable fields — extra insurance beyond
    // the schema (Zod only accepts `properties` in the body, but guard against
    // future body-schema relaxation).
    const bodyKeys = Object.keys(body);
    for (const k of bodyKeys) {
      if (k !== "properties") {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Edge ${k} is immutable after creation`,
        );
      }
    }
    // Fence the write to the caller's space — belt to the 404-cloak above.
    const updated = await storage.edges.updateProperties(
      id,
      body.properties,
      spaceId,
    );
    // An edit is as observable as a create or a delete. Without this the
    // SDK could change an edge through this route and nothing propagated
    // it, so a second device kept the stale payload with nothing to say
    // otherwise.
    await publishEdge({ type: "edge_updated", edge: updated, spaceId });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "edge.update",
      resource_type: "edge",
      resource_id: id,
      details: { edge_type: existing.edge_type },
    });
    return c.json({ edge: updated }, 200);
  });

  router.openapi(deleteEdgeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const spaceId = c.get("apiKey")?.space_id;
    const existing = await storage.edges.get(id);
    // `edges.get` is unscoped, so 404-cloak any edge outside the caller's
    // space: a space-scoped caller must never learn another space's edge
    // exists, let alone delete it. Platform-admin / single-space keys carry
    // no space_id and skip the check.
    if (!existing || (spaceId && existing.space_id !== spaceId)) {
      throw new MarfaError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
    }
    // Use getIncludingTrashed so edges whose source item is trashed
    // still run the source-type permission check. A plain
    // storage.items.get() returns null for trashed sources, which would
    // silently skip the gate and let a credential without the source
    // type's write permission mutate the edge.
    const srcItem = await storage.items.getIncludingTrashed(
      existing.source_id,
      spaceId,
    );
    if (srcItem) requireTypeAccess(c, srcItem.type, "write");
    requireEdgePermission(c, existing.edge_type, "write");
    // Fence the delete to the caller's space — belt to the 404-cloak above.
    await storage.edges.delete(id, spaceId);
    await publishEdge({
      type: "edge_deleted",
      edge: existing,
      spaceId,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "edge.delete",
      resource_type: "edge",
      resource_id: id,
      details: { edge_type: existing.edge_type },
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Per-item edge listings (mounted at /items)
// ---------------------------------------------------------------------------

const listFromSourceRoute = createRoute({
  method: "get",
  path: "/{id}/edges",
  operationId: "listItemEdges",
  tags: ["Edges"],
  summary: "List outbound edges from an item",
  description:
    "Returns the edges where this item is the source, paginated and optionally filtered by edge type. Use the backrefs endpoint for edges pointing at the item.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Item id.") }),
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe("Filter to a single edge type."),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum edges to return per page."),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgeListSchema } },
      description: "Outbound edges",
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
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: "Item not found",
    },
  },
});

const listBackrefsRoute = createRoute({
  method: "get",
  path: "/{id}/backrefs",
  operationId: "listItemBackrefs",
  tags: ["Edges"],
  summary: "List inbound edges to an item",
  description:
    "Returns the edges where this item is the target (backrefs), paginated and optionally filtered by edge type. Use the edges endpoint for edges pointing away from the item.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Item id.") }),
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe("Filter to a single edge type."),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum edges to return per page."),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgeListSchema } },
      description: "Inbound edges",
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
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: "Item not found",
    },
  },
});

export function itemEdgeListingRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listFromSourceRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    const spaceId = c.get("apiKey")?.space_id;
    const item = await storage.items.get(id, spaceId);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    const q = c.req.valid("query");
    const result = await storage.edges.listFromSource(id, {
      edge_type: parseEdgeTypeFilter(q.edge_type),
      limit: q.limit,
      cursor: q.cursor,
    });
    return c.json(result, 200);
  });

  router.openapi(listBackrefsRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    const spaceId = c.get("apiKey")?.space_id;
    const item = await storage.items.get(id, spaceId);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    const q = c.req.valid("query");
    const result = await storage.edges.listToTarget(id, {
      edge_type: parseEdgeTypeFilter(q.edge_type),
      limit: q.limit,
      cursor: q.cursor,
    });
    return c.json(result, 200);
  });

  return router;
}
