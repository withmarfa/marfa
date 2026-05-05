import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MymeError, isValidId } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireEdgePermission,
  requireTypeAccess,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import { assertEdgeCanBeCreated } from "../storage/edge-constraints.js";
import { publishEdge } from "../pubsub.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EdgeSchema = z.object({
  id: z.string(),
  tenant_id: z.string().nullable().optional(),
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
    throw new MymeError(
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
  tags: ["Edges"],
  summary: "List all edges across the tenant, filtered by edge type",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe(
          "Comma-separated edge types. Up to 10 entries. Omit to list every edge.",
        ),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgeListSchema } },
      description: "Edges, paginated",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error (e.g. too many edge types in filter)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const createEdgeRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Edges"],
  summary: "Create a single edge",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation / constraint / cycle error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Source, target, or edge type not found",
    },
  },
});

const updateEdgeRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Edges"],
  summary:
    "Update edge properties (edge_type, source_id, target_id are immutable)",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Attempted to change immutable field",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Edge not found",
    },
  },
});

const deleteEdgeRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Edges"],
  summary: "Delete an edge",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Deleted",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
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
    const tenantId = c.get("apiKey")?.tenant_id;
    const q = c.req.valid("query");
    const result = await storage.edges.list({
      tenantId,
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
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid source_id");
    }
    if (!isValidId(body.target_id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid target_id");
    }
    const tenantId = c.get("apiKey")?.tenant_id;

    // Dual gate: source item's type permission + edge type permission.
    // Admin keys bypass both via the helpers.
    const sourceItem = await storage.items.get(body.source_id, tenantId);
    if (!sourceItem) {
      throw new MymeError(
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
        tenant_id: tenantId,
      });
      return storage.edges.createRaw(
        {
          source_id: body.source_id,
          target_id: body.target_id,
          edge_type: body.edge_type,
          properties: body.properties,
        },
        tenantId,
      );
    });
    await publishEdge({ type: "edge_created", edge, tenantId });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
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
    const existing = await storage.edges.get(id);
    if (!existing) {
      throw new MymeError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
    }
    // Use getIncludingTrashed so edges whose source item is trashed
    // still run the source-type permission check. Previously
    // storage.items.get() returned null for trashed sources, which
    // silently skipped the gate and let a credential without the
    // source type's write permission mutate the edge.
    const srcItem = await storage.items.getIncludingTrashed(
      existing.source_id,
      c.get("apiKey")?.tenant_id,
    );
    if (srcItem) requireTypeAccess(c, srcItem.type, "write");
    requireEdgePermission(c, existing.edge_type, "write");
    // Reject attempts to change immutable fields — extra insurance beyond
    // the schema (Zod only accepts `properties` in the body, but guard against
    // future body-schema relaxation).
    const bodyKeys = Object.keys(body as object);
    for (const k of bodyKeys) {
      if (k !== "properties") {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Edge ${k} is immutable after creation`,
        );
      }
    }
    const updated = await storage.edges.updateProperties(id, body.properties);
    return c.json({ edge: updated }, 200);
  });

  router.openapi(deleteEdgeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const existing = await storage.edges.get(id);
    if (!existing) {
      throw new MymeError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
    }
    // Use getIncludingTrashed so edges whose source item is trashed
    // still run the source-type permission check. Previously
    // storage.items.get() returned null for trashed sources, which
    // silently skipped the gate and let a credential without the
    // source type's write permission mutate the edge.
    const srcItem = await storage.items.getIncludingTrashed(
      existing.source_id,
      c.get("apiKey")?.tenant_id,
    );
    if (srcItem) requireTypeAccess(c, srcItem.type, "write");
    requireEdgePermission(c, existing.edge_type, "write");
    await storage.edges.delete(id);
    await publishEdge({
      type: "edge_deleted",
      edge: existing,
      tenantId: c.get("apiKey")?.tenant_id,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
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
  tags: ["Edges"],
  summary: "List outbound edges from an item",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      edge_type: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgeListSchema } },
      description: "Outbound edges",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

const listBackrefsRoute = createRoute({
  method: "get",
  path: "/{id}/backrefs",
  tags: ["Edges"],
  summary: "List inbound edges (backrefs) targeting an item",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      edge_type: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgeListSchema } },
      description: "Inbound edges",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
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
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    const tenantId = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tenantId);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
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
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    const tenantId = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tenantId);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
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
