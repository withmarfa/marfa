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
import { EdgeSchema } from "./_schemas.js";
import { assertEdgeCanBeCreated } from "../storage/edge-constraints.js";
import { publishEdge } from "../pubsub.js";
import { refuseRenamedTimeQueryParams } from "./_renamed-time-filters.js";
import {
  refuseUnknownQueryParams,
  UNKNOWN_PARAM_NOTE,
} from "./_unknown-query-keys.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

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
 * either way — and so that nothing parses it as an item's snapshot. The
 * body still carries the whole edge rather than a version number now that
 * `GET /edges/{id}` exists: a refused client can retry from what it was
 * handed instead of spending a round trip re-reading what the refusal
 * already knew.
 */
const EdgeConflictSchema = z.object({
  error: z.object({
    code: z.literal("version_conflict"),
    status: z.literal(409),
    /** Prose for a person, as on the item door. Branch on `code`, never on
     *  this text. It is here because an envelope that describes itself on
     *  one door and not its sibling is the disagreement a client discovers
     *  the hard way. */
    message: z.string(),
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
    "Removals are a different question and this read cannot answer it. A deleted edge leaves no row and no tombstone, so nothing here distinguishes one that was removed from one that never existed. The event stream carries the deletions; a client that reconciles completely needs both channels.\n\n" +
    UNKNOWN_PARAM_NOTE +
    " The two retired time-filter names are refused here too, naming their replacements, even though this door never carried them — the published rename says it covers this listing, and an absence discovered at `200` over the whole corpus is the failure that refusal exists to prevent.",
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
      description:
        "Too many edge types in the filter, an unrecognized query " +
        "parameter, or one of the two retired time-filter names. This " +
        "door already answered the first; the change that made it answer " +
        "the other two is the reason the sentence names all three.",
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

const getEdgeRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getEdge",
  tags: ["Edges"],
  summary: "Get an edge",
  description:
    "Returns one edge by its id. The other ways to read an edge all need something the caller may not have: the whole space filtered by type, or the outbound and inbound listings on an item, which require knowing an endpoint. A client holding only an edge id -- one whose queued update was refused, or whose event arrived before its endpoints did -- could otherwise only scan. Cloaked as 404 across a space boundary, exactly as update and delete are.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().describe("Edge id.") }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ edge: EdgeSchema }) },
      },
      description: "The edge",
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

const updateEdgeRoute = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "updateEdge",
  tags: ["Edges"],
  summary: "Update an edge",
  description:
    "Updates an edge's properties. Properties merge shallowly with what the edge already holds, as they do on items, so a call naming one property leaves the others standing; there is no replace mode and no way to remove a single property: sending `null` stores a null rather than clearing the key, and deleting the edge to recreate it restarts its version at 1 and emits a delete and a create rather than an update. An edge's property set can therefore only grow. The identity fields (edge type, source, and target) are immutable, so re-pointing an edge means deleting it and creating a new one. Passing `version` opts into optimistic concurrency: a stale value returns 409 carrying the edge as it now stands, and the client re-applies its change over that. Omitting it keeps the previous last-writer-wins behavior. The version moves on either way, and on every update applied rather than only on one that changes the properties — so a bulk upsert that rewrites identical properties still invalidates a version another client is holding.",
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

    // The edge listing never carried the retired names, so there was
    // nothing to refuse and no refusal was written. The published
    // rename says otherwise: it describes the rename as covering this
    // door, so a client migrating exactly as instructed writes
    // `timestamp_after` here and, unrefused, receives a silently
    // unfiltered page at 200 with a well-formed cursor.
    refuseRenamedTimeQueryParams(c.req.raw.url, {
      catchUpFilter: "updated_after",
    });
    refuseUnknownQueryParams(c.req.raw.url, listEdgesRoute.request.query);
    const q = c.req.valid("query");
    const result = await storage.edges.list({
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

    // Dual gate: the source item's type permission and the edge type's, and
    // nothing bypasses either. There is no rank left to bypass on, and the
    // operator flag is not an exception — it is not consulted here at all, so
    // a credential carrying it is refused on an ordinary edge exactly like
    // any other credential whose maps do not cover it. The one carve-out
    // either helper makes is for a reserved namespace, and that does not fire
    // for an ordinary type.
    const sourceItem = await storage.items.get(body.source_id);
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
        });
        return storage.edges.createRaw({
          id: body.id,
          source_id: body.source_id,
          target_id: body.target_id,
          edge_type: body.edge_type,
          properties: body.properties,
        });
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
    await publishEdge({ type: "edge_created", edge });
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

  router.openapi(getEdgeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const existing = await storage.edges.get(id);
    if (!existing) {
      throw new MarfaError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
    }
    // The same two gates update and delete apply, at `read` rather than
    // `write`. Reading an edge discloses both endpoints and the properties
    // on it, so a caller who may not read the source's type may not learn
    // the relationship either.
    //
    // getIncludingTrashed for the reason the write paths use it: a plain
    // `items.get` returns null for a trashed source, and a null source
    // skips the type gate entirely rather than failing it. Trashing the
    // source item would otherwise turn a refusal into a disclosure.
    const srcItem = await storage.items.getIncludingTrashed(existing.source_id);
    if (srcItem) requireTypeAccess(c, srcItem.type, "read");
    requireEdgePermission(c, existing.edge_type, "read");
    return c.json({ edge: existing }, 200);
  });

  router.openapi(updateEdgeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await storage.edges.get(id);
    if (!existing) {
      throw new MarfaError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
    }
    // Use getIncludingTrashed so edges whose source item is trashed
    // still run the source-type permission check. A plain
    // storage.items.get() returns null for trashed sources, which would
    // silently skip the gate and let a credential without the source
    // type's write permission mutate the edge.
    const srcItem = await storage.items.getIncludingTrashed(existing.source_id);
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
      body.version,
    );
    if (!result.ok) {
      // The edit was computed from a state the server has left. Hand back
      // the whole current edge so the client can re-apply over it without
      // a second round trip to `GET /edges/{id}`.
      //
      // Returned rather than thrown, so the error handler that normally sets
      // this never runs. Same rule as the item door: a fresh refusal and its
      // idempotent replay must not describe one conflict differently.
      c.header("X-Error-Code", "version_conflict");
      return c.json(
        {
          error: {
            code: "version_conflict" as const,
            status: 409 as const,
            // No ancestor and no field list to name here — an edge has no
            // per-version history — so the message says the one thing this
            // refusal knows and the caller needs.
            message:
              `Version ${String(body.version)} is stale; the edge is now at ` +
              `version ${String(result.current.version)}. Re-apply the change ` +
              `over the edge returned here and send again.`,
          },
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
    await publishEdge({ type: "edge_updated", edge: updated });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
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
    const existing = await storage.edges.get(id);
    if (!existing) {
      throw new MarfaError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
    }
    // Use getIncludingTrashed so edges whose source item is trashed
    // still run the source-type permission check. A plain
    // storage.items.get() returns null for trashed sources, which would
    // silently skip the gate and let a credential without the source
    // type's write permission mutate the edge.
    const srcItem = await storage.items.getIncludingTrashed(existing.source_id);
    if (srcItem) requireTypeAccess(c, srcItem.type, "write");
    requireEdgePermission(c, existing.edge_type, "write");
    await storage.edges.delete(id);
    await publishEdge({
      type: "edge_deleted",
      edge: existing,
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
  operationId: "listItemEdges",
  tags: ["Edges"],
  summary: "List outbound edges from an item",
  description: `Returns the edges where this item is the source, paginated and optionally filtered by edge type. Use the backrefs endpoint for edges pointing at the item. An item in the trash still answers with its edges, because an edge carries no lifecycle of its own: a 404 here means no such item, not a deleted one. Requires read access to the item's type. ${UNKNOWN_PARAM_NOTE}`,
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
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "An unrecognized query parameter. Declared because this door " +
        "answers it: a refusal a caller cannot find in the reference is " +
        "the same silence in a different place.",
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
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description: "No read access to the anchor item's type",
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
  description: `Returns the edges where this item is the target (backrefs), paginated and optionally filtered by edge type. Use the edges endpoint for edges pointing away from the item. An item in the trash still answers with its edges, because an edge carries no lifecycle of its own: a 404 here means no such item, not a deleted one. Requires read access to the item's type. ${UNKNOWN_PARAM_NOTE}`,
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
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "An unrecognized query parameter. Declared because this door " +
        "answers it: a refusal a caller cannot find in the reference is " +
        "the same silence in a different place.",
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
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description: "No read access to the anchor item's type",
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

    // The listing's twin. A misspelled `edge_type` here widens the
    // page from one type to every edge on the item, which is the
    // same silence on a smaller set.
    refuseUnknownQueryParams(c.req.raw.url, listFromSourceRoute.request.query);
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    // The trashed-inclusive read, matching the write doors above. Edges
    // carry no lifecycle of their own, and the collection-level listing
    // returns one whether or not an endpoint is in the bin — so the plain
    // read made the same edge reachable through one door and absent
    // through another, decided by the state of a row the edge does not
    // belong to. A client reconciling its copy has to see a trashed
    // item's edges; not-found tells it the item never existed, which is a
    // different thing and leads it to the wrong repair. A genuinely
    // absent item still answers not-found.
    //
    // **The swap admits exactly one more state, not every non-active
    // one.** `get` filters `trashed` and nothing else, so an archived or
    // a revoked anchor was already served through this door and still
    // is; only a trashed one is new. Worth stating because the two method
    // names invite reading `get` as "active only", and a reader who
    // believes that will look for a widening here that is not present.
    const item = await storage.items.getIncludingTrashed(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    // The anchor decides what this call returns, so reading it is a read
    // of the anchor — the same check every write door in this file makes
    // against its source item, and the one the item read doors make. It
    // is stated here rather than left to the space fence because the
    // fence and the type map answer different questions: a credential can
    // be inside the space and still hold no grant on this type.
    //
    // After the read rather than before it, because the check needs the
    // row's `type` and only the row carries it. The cost is that a
    // caller inside the space without the grant can tell 403 from 404 and
    // so learns the row exists. Accepted rather than overlooked: the item
    // read door resolves in the same order for the same reason, and
    // trading that away means answering 404 for a row the caller may not
    // read — a change to every typed read door at once, not to these two.
    requireTypeAccess(c, item.type, "read");
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

    // The listing's twin. A misspelled `edge_type` here widens the
    // page from one type to every edge on the item, which is the
    // same silence on a smaller set.
    refuseUnknownQueryParams(c.req.raw.url, listBackrefsRoute.request.query);
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    // The trashed-inclusive read, matching the write doors above. Edges
    // carry no lifecycle of their own, and the collection-level listing
    // returns one whether or not an endpoint is in the bin — so the plain
    // read made the same edge reachable through one door and absent
    // through another, decided by the state of a row the edge does not
    // belong to. A client reconciling its copy has to see a trashed
    // item's edges; not-found tells it the item never existed, which is a
    // different thing and leads it to the wrong repair. A genuinely
    // absent item still answers not-found.
    //
    // **The swap admits exactly one more state, not every non-active
    // one.** `get` filters `trashed` and nothing else, so an archived or
    // a revoked anchor was already served through this door and still
    // is; only a trashed one is new. Worth stating because the two method
    // names invite reading `get` as "active only", and a reader who
    // believes that will look for a widening here that is not present.
    const item = await storage.items.getIncludingTrashed(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    // The anchor decides what this call returns, so reading it is a read
    // of the anchor — the same check every write door in this file makes
    // against its source item, and the one the item read doors make. It
    // is stated here rather than left to the space fence because the
    // fence and the type map answer different questions: a credential can
    // be inside the space and still hold no grant on this type.
    //
    // After the read rather than before it, because the check needs the
    // row's `type` and only the row carries it. The cost is that a
    // caller inside the space without the grant can tell 403 from 404 and
    // so learns the row exists. Accepted rather than overlooked: the item
    // read door resolves in the same order for the same reason, and
    // trading that away means answering 404 for a row the caller may not
    // read — a change to every typed read door at once, not to these two.
    requireTypeAccess(c, item.type, "read");
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
