import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError, isValidId } from "@withmarfa/shared";
import type { Edge } from "@withmarfa/shared";
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
  version: z.number(),
});

/**
 * A refused update hands back the edge as it now stands.
 *
 * Deliberately not the item conflict envelope. That one carries an
 * ancestor snapshot, the fields in conflict, and the type's merge policy;
 * edges have no per-version history, no field-level merge, and no policy,
 * so three of those four slots would be invented. What a client needs here
 * is the current row and a version to retry against.
 *
 * Keyed `edge`, the same as the 200 body, so `res.edge` reads the same
 * either way — and so that nothing parses it as an item's snapshot. It
 * matters more than usual because there is no route that reads a single
 * edge by its id: this body is the only way back to a usable version.
 */
const EdgeConflictSchema = z.object({
  error: z.object({
    code: z.literal("version_conflict"),
    status: z.literal(409),
  }),
  edge: EdgeSchema,
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
    "Returns a paginated list of edges across the space, optionally filtered by edge type. Pass `edge_type` as a comma-separated list (up to 10 entries) to scope, or omit it to list every edge.\n\n" +
    "Edges carry no lifecycle state of their own and are never hidden by the state of the items they join, so this listing has no `state` parameter and needs none: an edge whose endpoints are in the bin is returned like any other. That is deliberate — a client reconciling its copy has to see those edges rather than watch them disappear.\n\n" +
    "Removals are a different question and this read cannot answer it. A deleted edge leaves no row and no tombstone, so nothing here distinguishes one that was removed from one that never existed. The event stream carries the deletions; a client that reconciles completely needs both channels.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe(
          "Comma-separated edge types. Up to 10 entries. Omit to list every edge.",
        ),
      updated_after: z
        .string()
        // Non-empty for the same reason as the item listing: this
        // parameter chooses the ordering, so an empty value would order
        // for a catch-up and bound nothing.
        .min(1)
        .optional()
        .describe(
          "Lower bound on `updated_at`, when the edge last changed (inclusive). The catch-up filter, matching `GET /items`. An RFC 3339 timestamp in any valid spelling; it is normalized before the comparison. Changes the order from newest-created-first to `(updated_at, id)` ascending, so a cursor from one ordering cannot be continued under the other and is refused if tried. Inclusive because `updated_at` ties across a bulk write, so deduplicate by id — and a high-water mark landing on an instant a large bulk write shares means that whole group is re-sent on every reconnect.",
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
    "Creates a single typed edge between two existing items in the space. Writes are dual-gated, requiring write permission on both the source item's type and the edge type, and edge-type constraints and cycle rules are enforced at create time. A caller may supply the edge `id`, as `POST /items` allows for an item, so a client that mints ids locally keeps its own identifier for the row; omit it and the server mints one. An `id` already naming this exact edge is treated as a repeat of a create the server already performed: nothing is written, no event is published, and the stored edge comes back with `acknowledged: true` and status 200. An `id` naming a different edge is refused with 409 `conflict`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            id: z
              .string()
              .optional()
              .describe(
                "Client-supplied edge id. Omit to have the server mint one.",
              ),
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
    200: {
      content: {
        "application/json": {
          schema: z.object({
            edge: EdgeSchema,
            acknowledged: z.boolean(),
          }),
        },
      },
      description:
        "The supplied `id` already names this exact edge — same source, target and type — so the create is treated as a repeat of one the server already performed. Nothing is written and no event is published; the stored edge is returned with `acknowledged: true`.",
    },
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
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description:
        "The supplied `id` is taken by an edge that is not the one this request describes — a different source, target or type — or by one in a space the caller cannot see. An id naming this exact edge is a repeat and answers 200 instead. The response names the id as `existing_id`.",
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
    "Updates an edge's properties. The identity fields (edge type, source, and target) are immutable, so re-pointing an edge means deleting it and creating a new one. Passing `version` opts into optimistic concurrency: a stale value returns 409 carrying the edge as it now stands, and the client re-applies its change over that. Omitting it keeps the previous last-writer-wins behavior. The version moves on either way, and on every update applied rather than only on one that changes the properties — so a bulk upsert that rewrites identical properties still invalidates a version another client is holding.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Edge id.") }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            properties: z.record(z.string(), z.unknown()),
            version: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                "The version the client read. A stale value is refused with 409; omitted, the write is unconditional.",
              ),
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
    409: {
      content: {
        "application/json": { schema: EdgeConflictSchema },
      },
      description:
        "The version supplied is stale; the body carries the current edge",
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
      updated_after: q.updated_after,
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
    // Gated at the door like the item id it mirrors. Not because an
    // ungated id would be unreachable — `PATCH` and `DELETE /edges/{id}`
    // address any string, so the row would be perfectly usable — but
    // because an id is an id on every door that mints one, and a
    // malformed identifier that reaches the wire is one every reader of
    // it afterwards has to tolerate.
    if (body.id !== undefined && !isValidId(body.id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid edge ID");
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

    // A create arriving a second time under an id the caller minted.
    //
    // A synced client names a row before the server has seen it, so when
    // the response to its create is lost it retries with the same id. The
    // second arrival of an id the server already holds is that client's
    // own write, so the contract answers success and returns the row
    // rather than making every engine implement the lookup itself.
    //
    // **A pre-check and a catch, as the item door has.** The pre-check is
    // load-bearing here rather than an optimization:
    // `assertEdgeCanBeCreated` refuses an exact duplicate triple before
    // any insert, so a client replaying its own create meets that 400 and
    // never reaches the primary-key collision. The catch covers what the
    // pre-check cannot — two sends of one id both finding nothing, where
    // the loser of the insert still needs an answer other than 409.
    //
    // One comparison serves both.
    //
    // Gated above rather than here: the gates ran on the body's source
    // type and edge type, and an acknowledgement is only ever returned
    // when the row's triple equals the body's — so gating on the body is
    // gating on the row.
    const repeatedEdge = async (): Promise<Edge | null> => {
      if (body.id === undefined) return null;
      const existing = await storage.edges.get(body.id);
      if (!existing) return null;
      // `edges.get` is unscoped, so an edge outside the caller's space is
      // left to the store's own collision trap: it is somebody else's row
      // and this caller must not learn it exists, let alone read it back.
      if (spaceId && existing.space_id !== spaceId) return null;
      const sameEdge =
        existing.source_id === body.source_id &&
        existing.target_id === body.target_id &&
        existing.edge_type === body.edge_type;
      if (sameEdge) return existing;
      // The id is this caller's to see and names something else. That is
      // a genuine collision rather than a repeat.
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Edge with id=${body.id} already exists`,
        { existing_id: body.id },
      );
    };

    const alreadyHeld = await repeatedEdge();
    if (alreadyHeld) {
      return c.json({ edge: alreadyHeld, acknowledged: true }, 200);
    }

    let edge: Edge;
    try {
      edge = await storage.runInTransaction(async () => {
        await assertEdgeCanBeCreated(storage.edges, storage.items, {
          source_id: body.source_id,
          target_id: body.target_id,
          edge_type: body.edge_type,
          space_id: spaceId,
        });
        return storage.edges.createRaw(
          {
            id: body.id,
            source_id: body.source_id,
            target_id: body.target_id,
            edge_type: body.edge_type,
            properties: body.properties,
          },
          spaceId,
        );
      });
    } catch (err) {
      // The concurrency backstop. The row appeared between the pre-check
      // and the insert, which is the one case the pre-check cannot cover.
      const isOwnIdCollision =
        body.id !== undefined &&
        err instanceof MarfaError &&
        err.code === ErrorCode.CONFLICT &&
        (err.details as { existing_id?: string } | undefined)?.existing_id ===
          body.id;
      if (!isOwnIdCollision) throw err;
      const raced = await repeatedEdge();
      if (!raced) throw err;
      return c.json({ edge: raced, acknowledged: true }, 200);
    }
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
    // the schema (Zod strips anything the body schema does not name, but
    // guard against future body-schema relaxation).
    //
    // `version` is a precondition on the write, not a field of the row, so
    // it belongs on the allowed side of this guard. Naming it explicitly
    // rather than reading the schema keeps the guard's list the thing a
    // reader checks against.
    const bodyKeys = Object.keys(body);
    for (const k of bodyKeys) {
      if (k !== "properties" && k !== "version") {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Edge ${k} is immutable after creation`,
        );
      }
    }
    // Fence the write to the caller's space — belt to the 404-cloak above.
    const result = await storage.edges.updateProperties(
      id,
      body.properties,
      spaceId,
      body.version,
    );
    if (!result.ok) {
      // The edit was computed from a state the server has left. Hand back
      // the whole current edge: there is no route that reads one edge by
      // id, so a client refused here has nowhere else to go for the
      // version it needs to retry against.
      return c.json(
        {
          error: { code: "version_conflict" as const, status: 409 as const },
          edge: result.current,
        },
        409,
      );
    }
    const updated = result.edge;
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
