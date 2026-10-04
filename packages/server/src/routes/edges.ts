import { runAuditedTransaction } from "../storage/audited-transaction.js";
import {
  rememberEdgeSubject,
  rememberItemSubject,
} from "../middleware/replay-requirements.js";
import { ITEM_NOT_FOUND, READ_REFUSED } from "./_item-refusals.js";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  ErrorCode,
  MarfaError,
  getEdgeTypeSchema,
  isValidId,
} from "@withmarfa/shared";
import type { Edge, Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  getTypeFilter,
  mayReadEdgeEnd,
  mayReadRow,
  requireAuth,
  requireEdgePermission,
  requireReadableRow,
  requireTypeAccess,
  readsSomeType,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import {
  EdgeResponseSchema,
  EdgePageSchema,
  EdgeSchema,
  VersionConflictErrorSchema,
} from "./_schemas.js";
import { refuseReusedEdgeId } from "./_reused-edge-id.js";
import {
  edgeKindReadable,
  edgeReadable,
  readableEdges,
  sourceTypesFor,
} from "./_edge-visibility.js";
import {
  assertEdgeCanBeCreated,
  assertEdgesCanBeCreated,
  edgeSourceNotFound,
  edgeTargetNotFound,
} from "../storage/edge-constraints.js";
import { mergeUpdateProperties } from "../storage/merge-properties.js";
import { publishEdge } from "../pubsub.js";
import { refuseUnknownQueryParams } from "./_unknown-query-keys.js";
import { pageLimit, pageCursor } from "../page-limits.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * A refused update hands back the edge as it now stands.
 *
 * **Keyed `current`, like every other door that refuses a single write
 * with `version_conflict`.** A client reading `body.current.version` off
 * one such 409 reads it off all of them, which is what lets a refusal be
 * handled without knowing which door answered. (The bulk doors are not in
 * that set: `POST /edges/bulk` reports the code per entry inside its own
 * envelope.) The whole row rather than a version number, so a refused
 * client can retry from what it was handed instead of spending a round
 * trip on `GET /edges/{id}`.
 *
 * What is absent is what the item envelope carries and an edge has none
 * of: no ancestor snapshot, no fields in conflict, no merge policy. Edges
 * have no per-version history and no field-level merge, so three of those
 * four slots would be invented.
 */
const EdgeConflictSchema = z
  .object({
    error: VersionConflictErrorSchema,
    current: EdgeSchema,
  })
  .openapi("EdgeVersionConflict");

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

/** The ends an update moves the edge to, or `null`; judged here so a move is
 *  refused for each new end as a create would refuse it. */
async function endsAfterMove(
  c: Context<AppEnv>,
  storage: Storage,
  existing: Edge,
  body: { source_id?: string; target_id?: string },
): Promise<{ source_id: string; target_id: string } | null> {
  const ends = {
    source_id: body.source_id ?? existing.source_id,
    target_id: body.target_id ?? existing.target_id,
  };
  const movesSource = ends.source_id !== existing.source_id;
  const movesTarget = ends.target_id !== existing.target_id;
  if (!movesSource && !movesTarget) return null;
  if (!isValidId(ends.source_id)) {
    throw new MarfaError(ErrorCode.INVALID_ID, "Invalid source_id");
  }
  if (!isValidId(ends.target_id)) {
    throw new MarfaError(ErrorCode.INVALID_ID, "Invalid target_id");
  }
  if (movesSource && movesTarget) {
    throw moveRefusal(
      "source_id",
      "An update moves one end of an edge at a time; delete it and create the edge wanted",
    );
  }
  const schema = getEdgeTypeSchema(existing.edge_type);
  if (!schema) {
    throw new MarfaError(
      ErrorCode.EDGE_TYPE_NOT_FOUND,
      `Unknown edge type: ${existing.edge_type}`,
    );
  }
  const moved = movesSource ? "source_id" : "target_id";
  const keptHoldsOne = movesSource
    ? schema.cardinality === "one-to-one" ||
      schema.cardinality === "one-to-many"
    : schema.cardinality === "one-to-one" ||
      schema.cardinality === "many-to-one";
  if (!keptHoldsOne) {
    throw moveRefusal(
      moved,
      `Edge "${existing.edge_type}" is ${schema.cardinality}, so the end that stays can hold more than this edge and there is none to replace; create the edge wanted and delete this one`,
    );
  }
  if (movesSource) {
    const source = requireReadableRow(
      c,
      await storage.items.get(ends.source_id),
      () => edgeSourceNotFound(ends.source_id),
    );
    requireTypeAccess(c, source, "write");
  }
  // Before any check that reads the target, so an unreadable one says no more than a missing one.
  const target = await storage.items.get(ends.target_id);
  if (!target || !mayReadEdgeEnd(c)(target.type)) {
    throw edgeTargetNotFound(ends.target_id);
  }
  rememberItemSubject(target, "read");
  return ends;
}

/**
 * The edge a door names by id and its source, answered as no edge where the
 * key may not read its type or its source, trashed or not, as every listing.
 */
async function readableEdge(
  c: Context<AppEnv>,
  storage: Storage,
  id: string,
): Promise<{ edge: Edge; source: Item | null }> {
  const key = requireAuth(c);
  getTypeFilter(c);
  const edge = await storage.edges.get(id);
  const source = edge
    ? await storage.items.getIncludingTrashed(edge.source_id)
    : null;
  if (
    !edge ||
    !edgeKindReadable(key, edge) ||
    (source && !mayReadRow(c, source))
  ) {
    throw new MarfaError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
  }
  rememberEdgeSubject(edge, "read", source?.type);
  return { edge, source };
}

function moveRefusal(field: string, message: string): MarfaError {
  return new MarfaError(ErrorCode.VALIDATION_ERROR, message, {
    errors: [{ path: field, message }],
  });
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
    "Returns a paginated list of edges the credential may read, optionally filtered by edge type. Pass `edge_type` as a comma-separated list (up to 10 entries) to scope, or omit it to list every edge this credential reaches.\n\n" +
    "Each row is held to the two permissions `GET /edges/{id}` asks for: read on the source item's type, and read on the edge type. A row failing either is left out, so a page can come back shorter than `limit` and can come back empty with a `next_cursor` still to follow. The cursor describes the whole listing rather than the page, so paging still walks it: stop on `next_cursor: null`, never on an empty page.\n\n" +
    "Edges carry no lifecycle state of their own and are never hidden by the state of the items they join, so this listing has no `state` parameter and needs none: an edge whose endpoints are in the bin is returned like any other. That is deliberate: a client reconciling its copy has to see those edges rather than watch them disappear.\n\n" +
    "Removals are a different question and this read cannot answer it. A deleted edge leaves no row and no record of itself, so nothing here distinguishes one that was removed from one that never existed. The event stream carries the deletions; a client that reconciles completely needs both channels.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
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
          "Lower bound on `updated_at`, when the edge last changed (inclusive). The catch-up filter, matching `GET /items`. An RFC 3339 instant in any valid spelling; it is normalized before the comparison. Changes the order from newest-created-first to `(updated_at, id)` ascending, so a cursor from one ordering cannot be continued under the other and is refused if tried. Inclusive because `updated_at` ties across a bulk write, so deduplicate by id, and a high-water mark landing on an instant a large bulk write shares means that whole group is re-sent on every reconnect.",
        ),
      updated_before: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Upper bound on `updated_at` (exclusive), closing the window its lower twin opens. Exclusive where `updated_after` is inclusive, because this is an end point the caller chooses rather than a resume point that must not drop a tie. It leaves the ordering alone.",
        ),
      limit: pageLimit({ max: 500 }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgePageSchema } },
      description: "Edges, paginated",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "Too many edge types in the filter, or an unrecognized query parameter.",
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
      description:
        "The credential's type permissions reach no type, so there is nothing on the data plane it may read. A credential that reaches some types reads this listing rather than being refused.",
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
    "Creates a single typed edge between two existing items. Writes are dual-gated, requiring write permission on both the source item's type and the edge type, and edge-type constraints and cycle rules are enforced at create time. A caller may supply the edge `id`, as `POST /items` allows for an item, so a client that mints ids locally keeps its own identifier for the row; omit it and the server mints one. An `id` already naming this exact edge is treated as a repeat of a create the server already performed: nothing is written, no event is published, and the stored edge comes back with `acknowledged: true` and status 200.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
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
        "The supplied `id` already names this exact edge (same source, target and type), so the create is treated as a repeat of one the server already performed. Nothing is written and no event is published; the stored edge is returned with `acknowledged: true`.",
    },
    201: {
      content: {
        "application/json": { schema: EdgeResponseSchema },
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_permission_denied",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "The dual gate refused one of its halves: `edge_permission_denied` on the edge type, `type_not_permitted` on a source item whose type the credential may read and not write. `type_not_permitted` also where its type permissions reach no type.",
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
      description:
        "The source, the target or the edge type is not found. A source or target of a type the credential may not read answers alike, with the same code and message.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["id_reused"]),
        },
      },
      description:
        "`id_reused`: the supplied `id` is taken by an edge that is not the one this request describes. An id naming this exact edge is a repeat and answers 200 instead. The response names the id as `existing_id` and what disagrees as `differs`: any of `source_id`, `target_id` and `edge_type`. `POST /items` answers the same code for an id already used, so a client sorts the two doors' collisions together. An `id` held by an edge you may not read answers the same code, and the response says only that the ID is taken.",
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
    "Returns one edge by its ID. Use it when you hold only an edge's ID, such as from an event.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: { params: z.object({ id: z.string().describe("Edge id.") }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: EdgeResponseSchema },
      },
      description: "The edge",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description:
        "The credential's type permissions reach no type. An edge of a type it may not read, or with a source it may not read, answers 404 as a missing edge does.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_not_found"]),
        },
      },
      description:
        "- `edge_not_found`: no edge you may read has this ID. An edge whose edge type or source item you may not read answers the same.",
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
    "Updates an edge's properties, or moves one of its ends, under the version the caller read. Properties merge shallowly with what the edge already holds, as they do on items, so a call naming one property leaves the others standing; there is no replace mode and no way to remove a single property: sending `null` stores a null rather than clearing the key. An edge's property set can therefore only grow.\n\n" +
    "**Moving an end.** `target_id` moves the edge to another target where its type lets a source hold one edge (`one-to-one`, `many-to-one`), and `source_id` moves it to another source where its type lets a target hold one (`one-to-one`, `one-to-many`): the end that stays holds one edge of the type, and this replaces it. The edge keeps its id and its properties, takes any named here, and moves in one write, so no reader ever sees that end with no edge or with two. The edge as it would stand is judged as a create is: the ends exist, a new source's type is one the caller may write, and the type constraints, cardinality at the new end, duplicates and cycles hold. One `edge.updated` announces the move, carrying the edge as it now stands. The edge type never changes.\n\n" +
    "`version` is required. The version moves on with every accepted write, and on every update applied rather than only on one that changes the properties, so a bulk upsert that rewrites identical properties still invalidates a version another client is holding.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({ id: z.string().describe("Edge id.") }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            properties: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                "Properties to merge over the ones the edge holds. Required unless an end moves.",
              ),
            source_id: z
              .string()
              .optional()
              .describe(
                "The source to move the edge to, where each target holds one edge of its type.",
              ),
            target_id: z
              .string()
              .optional()
              .describe(
                "The target to move the edge to, where each source holds one edge of its type.",
              ),
            version: z
              .number()
              .int()
              .min(0)
              .describe(
                "The version the caller read. Required, and a stale value is refused with 409: an update carries the version it is based on, or it is not an update but a blind overwrite.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: EdgeResponseSchema },
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
            "invalid_id",
            "edge_constraint_violation",
            "edge_cycle",
          ]),
        },
      },
      description:
        "`missing_required_field` for no `version`, or no `properties` where no end moves; `validation_error` for a body moving both ends, or an end of a type that holds more than one edge at the end that stays, and for properties the type refuses; `invalid_id` for a malformed end; `edge_constraint_violation` and `edge_cycle` for an edge the moved end cannot hold, as a create answers them.",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_permission_denied",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "The dual gate refused one of its halves: `edge_permission_denied` on an edge type the credential may read and not write, `type_not_permitted` on a source item whose type the credential may read and not write, and on the new one's where the source moves. A trashed source still gates on its type. `type_not_permitted` also where its type permissions reach no type.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_not_found",
            "item_not_found",
            "edge_type_not_found",
          ]),
        },
      },
      description:
        "`edge_not_found` for the edge, and for one whose edge type or source item the caller may not read; `item_not_found` for an end it would move to that does not exist or is of a type the caller may not read, or an end that stays and is in the bin, which a create of the edge would be refused for too; `edge_type_not_found` for an edge whose type is no longer registered, which has no cardinality to move it by.",
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
    "Deletes an edge by ID and leaves the items it joined as they are. The edge type's `cascade_on_delete` applies when an item is deleted, not when an edge is.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: { params: z.object({ id: z.string().describe("Edge id.") }) },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Deleted",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_permission_denied",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "The dual gate refused one of its halves: `edge_permission_denied` on an edge type the credential may read and not write, `type_not_permitted` on a source item whose type the credential may read and not write. A trashed source still gates on its type. `type_not_permitted` also where its type permissions reach no type.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_not_found"]),
        },
      },
      description:
        "- `edge_not_found`: no edge you may read has this ID, including one another request deleted first. Marfa publishes no event for it. An edge whose edge type or source item you may not read answers the same.",
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

    // The same question every other data-plane listing asks. Its answer
    // is not a store filter here, because an edge's readability is its
    // source item's rather than its own and no column carries that; the
    // call refuses a credential whose map reaches no type at all, which
    // `GET /edges/{id}` beside it already refuses.
    getTypeFilter(c);

    // An edge has no time of its own, so this door carries only the
    // modification-time bounds. A caller reaching for `occurred_after`
    // here has to be refused rather than served an unfiltered page at 200
    // with a well-formed cursor.
    refuseUnknownQueryParams(c.req.raw.url, listEdgesRoute.request.query);
    const q = c.req.valid("query");
    const result = await storage.edges.list({
      edge_type: parseEdgeTypeFilter(q.edge_type),
      updated_after: q.updated_after,
      updated_before: q.updated_before,
      limit: q.limit,
      cursor: q.cursor,
    });

    // The two questions `GET /edges/{id}` asks, asked of every row through
    // the one function every plural door calls. The
    // cursor is the store's and is untouched, so a page can come back
    // short — empty, even, with a cursor still to follow — and paging still
    // walks the whole listing.
    const key = requireAuth(c);
    const visible = await readableEdges(storage, key, result.data);
    return c.json({ ...result, data: visible }, 200);
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

    // Everything below reads, judges and writes inside one transaction, so
    // the source's type, a repeat of the id and the graph the checker judges
    // are the ones the write lands on.
    const outcome = await runAuditedTransaction(
      storage,
      async () => {
        // Dual gate: the source item's type permission and the edge type's,
        // and nothing bypasses either. There is no rank left to bypass on,
        // and the operator flag is not an exception — it is not consulted
        // here at all, so a credential carrying it is refused on an ordinary
        // edge exactly like any other credential whose maps do not cover it.
        // The one carve-out either helper makes is for a reserved namespace,
        // and that does not fire for an ordinary type.
        const sourceItem = requireReadableRow(
          c,
          await storage.items.get(body.source_id),
          () => edgeSourceNotFound(body.source_id),
        );
        requireTypeAccess(c, sourceItem, "write");
        requireEdgePermission(c, body.edge_type, "write");

        // A create arriving a second time under an id the caller minted.
        //
        // A synced client names a row before the server has seen it, so
        // when the response to its create is lost it retries with the same
        // id. The second arrival of an id the server already holds is that
        // client's own write, so the contract answers success and returns
        // the row rather than making every engine implement the lookup
        // itself. Asked before the checker, which would refuse the repeated
        // triple as a duplicate.
        //
        // Gated above rather than here: the gates ran on the body's source
        // type and edge type, and an acknowledgment is only ever returned
        // when the row's triple equals the body's — so gating on the body
        // is gating on the row.
        if (body.id !== undefined) {
          const existing = await storage.edges.get(body.id);
          // An edge the caller may not read goes on to the insert's
          // collision, which says the id is taken and nothing of the edge.
          if (
            existing &&
            (await edgeReadable(storage, requireAuth(c), existing))
          ) {
            // The id is this caller's to see and names something else: a
            // genuine collision rather than a repeat, answered as the item
            // door answers an id already used, with `details.differs`
            // saying which part of the stored row disagrees. Shared with
            // the bulk door, so the code cannot depend on how many edges
            // were sent.
            refuseReusedEdgeId(existing, body);
            return {
              edge: existing,
              acknowledged: true,
              sourceType: sourceItem.type,
            };
          }
        }

        await assertEdgeCanBeCreated(
          storage,
          {
            source_id: body.source_id,
            target_id: body.target_id,
            edge_type: body.edge_type,
            properties: body.properties,
          },
          mayReadEdgeEnd(c),
        );
        const targetSubject = await storage.items.get(body.target_id);
        if (targetSubject) rememberItemSubject(targetSubject, "read");
        const created = await storage.edges.createRaw({
          id: body.id,
          source_id: body.source_id,
          target_id: body.target_id,
          edge_type: body.edge_type,
          properties: body.properties,
        });
        // With the edge, so the two commit together or not at all.
        await publishEdge({
          type: "edge_created",
          edge: created,
          sourceType: sourceItem.type,
        });
        return {
          edge: created,
          acknowledged: false,
          sourceType: sourceItem.type,
        };
      },
      ({ edge, acknowledged }) =>
        acknowledged
          ? null
          : {
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
            },
    );

    rememberEdgeSubject(outcome.edge, "write", outcome.sourceType);
    return outcome.acknowledged
      ? c.json({ edge: outcome.edge, acknowledged: true }, 200)
      : c.json({ edge: outcome.edge }, 201);
  });

  router.openapi(getEdgeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const { edge: existing } = await readableEdge(c, storage, id);
    return c.json({ edge: existing }, 200);
  });

  router.openapi(updateEdgeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    // The edge, its source's type and every end a move names are read and
    // judged inside the write's transaction, so a change landing between a
    // check and the write cannot pass the one and miss the other.
    const result = await runAuditedTransaction(
      storage,
      async () => {
        const { edge: existing, source: srcItem } = await readableEdge(
          c,
          storage,
          id,
        );
        if (srcItem) requireTypeAccess(c, srcItem, "write");
        requireEdgePermission(c, existing.edge_type, "write");
        rememberEdgeSubject(existing, "write", srcItem?.type);
        // A stale write is refused for what it was based on, before anything
        // it names is judged.
        if (existing.version !== body.version) {
          return { ok: false as const, current: existing, moved: false };
        }
        const ends = await endsAfterMove(c, storage, existing, body);
        if (ends === null && body.properties === undefined) {
          throw new MarfaError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "properties is required where no end moves",
            { field: "properties" },
          );
        }
        const properties = body.properties ?? {};
        if (ends !== null) {
          await assertEdgesCanBeCreated(
            storage,
            [
              {
                ...ends,
                edge_type: existing.edge_type,
                properties: mergeUpdateProperties(
                  existing.properties,
                  properties,
                ),
              },
            ],
            mayReadEdgeEnd(c),
            { replacing: existing },
          );
        }
        const written = await storage.edges.updateProperties(
          id,
          properties,
          body.version,
          ends ?? undefined,
        );
        if (!written.ok) return { ...written, moved: false };
        // An edit is as observable as a create or a delete: without it a
        // second device keeps the stale payload with nothing saying
        // otherwise. A move can change the source, so its type is read for
        // the edge as it now stands.
        const sourceTypes = await sourceTypesFor(storage, [
          written.edge.source_id,
        ]);
        rememberEdgeSubject(
          written.edge,
          "write",
          sourceTypes.get(written.edge.source_id),
        );
        await publishEdge({
          type: "edge_updated",
          edge: written.edge,
          sourceType: sourceTypes.get(written.edge.source_id),
        });
        return { ...written, moved: ends !== null };
      },
      (written) =>
        written.ok
          ? {
              client_ip: c.get("clientIp") ?? null,
              key_id: c.get("apiKey")?.id,
              action: "edge.update",
              resource_type: "edge",
              resource_id: id,
              details: written.moved
                ? {
                    edge_type: written.edge.edge_type,
                    source_id: written.edge.source_id,
                    target_id: written.edge.target_id,
                  }
                : { edge_type: written.edge.edge_type },
            }
          : null,
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
          current: result.current,
        },
        409,
      );
    }

    return c.json({ edge: result.edge }, 200);
  });

  router.openapi(deleteEdgeRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    await runAuditedTransaction(
      storage,
      async () => {
        const { edge: existing, source: srcItem } = await readableEdge(
          c,
          storage,
          id,
        );
        if (srcItem) requireTypeAccess(c, srcItem, "write");
        requireEdgePermission(c, existing.edge_type, "write");
        rememberEdgeSubject(existing, "write", srcItem?.type);
        const removed = await storage.edges.delete(id);
        if (!removed) {
          throw new MarfaError(
            ErrorCode.EDGE_NOT_FOUND,
            `Edge ${id} not found`,
          );
        }
        await publishEdge({
          type: "edge_deleted",
          edge: removed,
          sourceType: srcItem?.type,
        });
        return removed;
      },
      (removed) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "edge.delete",
        resource_type: "edge",
        resource_id: id,
        details: { edge_type: removed.edge_type },
      }),
    );

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
  summary: "List outbound edges",
  description:
    "Returns the edges where this item is the source, paginated and optionally filtered by edge type. Use the backrefs endpoint for edges pointing at the item. An item in the trash still answers with its edges, because an edge carries no lifecycle of its own. Requires read access to the item's type. Each row is held to the two permissions `GET /edges/{id}` asks for: read on the source item's type, and read on the edge type. A row failing either is left out, so a page can come back shorter than `limit` and can come back empty with a `next_cursor` still to follow. The cursor describes the whole listing rather than the page: stop on `next_cursor: null`, never on an empty page.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({ id: z.string().describe("Item id.") }),
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe("Filter to a single edge type."),
      limit: pageLimit({ max: 500 }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgePageSchema } },
      description: "Outbound edges",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "validation_error"]),
        },
      },
      description:
        "`invalid_id` for a malformed item id; `validation_error` for an " +
        "unrecognized query parameter. Declared because this door " +
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
      description: READ_REFUSED,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND,
    },
  },
});

const listBackrefsRoute = createRoute({
  method: "get",
  path: "/{id}/backrefs",
  operationId: "listItemBackrefs",
  tags: ["Edges"],
  summary: "List inbound edges",
  description:
    "Returns the edges where this item is the target (backrefs), paginated and optionally filtered by edge type. Use the edges endpoint for edges pointing away from the item. An item in the trash still answers with its edges, because an edge carries no lifecycle of its own. Requires read access to the item's type. Each row is held to the two permissions `GET /edges/{id}` asks for: read on the source item's type, and read on the edge type. A row failing either is left out, so a page can come back shorter than `limit` and can come back empty with a `next_cursor` still to follow. The cursor describes the whole listing rather than the page: stop on `next_cursor: null`, never on an empty page.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({ id: z.string().describe("Item id.") }),
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe("Filter to a single edge type."),
      limit: pageLimit({ max: 500 }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgePageSchema } },
      description: "Inbound edges",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "validation_error"]),
        },
      },
      description:
        "`invalid_id` for a malformed item id; `validation_error` for an " +
        "unrecognized query parameter. Declared because this door " +
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
      description: READ_REFUSED,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND,
    },
  },
});

export function itemEdgeListingRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listFromSourceRoute, async (c) => {
    const key = requireAuth(c);

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
    // read would make the same edge reachable through one door and absent
    // through another, decided by the state of a row the edge does not
    // belong to. A client reconciling its copy has to see a trashed
    // item's edges; not-found tells it the item never existed, which is a
    // different thing and leads it to the wrong repair. A genuinely
    // absent item still answers not-found.
    //
    // **`getIncludingTrashed` admits exactly one more state than `get`,
    // not every non-active one.** `get` filters `trashed` and nothing
    // else, so an archived or a revoked anchor is served either way; only
    // a trashed one is added. Worth stating because the two method
    // names invite reading `get` as "active only", and a reader who
    // believes that will look for a widening here that is not present.
    requireReadableRow(
      c,
      await storage.items.getIncludingTrashed(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    const q = c.req.valid("query");
    const result = await storage.edges.listFromSource(id, {
      edge_type: parseEdgeTypeFilter(q.edge_type),
      limit: q.limit,
      cursor: q.cursor,
    });
    // The anchor check above settles the source's type, since the anchor is
    // every row's source, but not the edge type. Both questions go through
    // the shared reading anyway: the redundant half is one keyed read, and a
    // parameter asserting the anchor was already authorized is a claim the
    // next caller can get wrong.
    const visible = await readableEdges(storage, key, result.data);
    return c.json({ ...result, data: visible }, 200);
  });

  router.openapi(listBackrefsRoute, async (c) => {
    const key = requireAuth(c);

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
    // read would make the same edge reachable through one door and absent
    // through another, decided by the state of a row the edge does not
    // belong to. A client reconciling its copy has to see a trashed
    // item's edges; not-found tells it the item never existed, which is a
    // different thing and leads it to the wrong repair. A genuinely
    // absent item still answers not-found.
    //
    // **`getIncludingTrashed` admits exactly one more state than `get`,
    // not every non-active one.** `get` filters `trashed` and nothing
    // else, so an archived or a revoked anchor is served either way; only
    // a trashed one is added. Worth stating because the two method
    // names invite reading `get` as "active only", and a reader who
    // believes that will look for a widening here that is not present.
    requireReadableRow(
      c,
      await storage.items.getIncludingTrashed(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    const q = c.req.valid("query");
    const result = await storage.edges.listToTarget(id, {
      edge_type: parseEdgeTypeFilter(q.edge_type),
      limit: q.limit,
      cursor: q.cursor,
    });
    // The anchor check above answers neither half here, which is what
    // made this the wider of the two doors: the anchor is the **target**,
    // and an edge's readability is its source item's — a row this door
    // never read. A credential holding read on one type therefore read
    // the relationships every other type has with it, and their
    // properties, from the one side that never consults them. The edge
    // type was not asked either.
    const visible = await readableEdges(storage, key, result.data);
    return c.json({ ...result, data: visible }, 200);
  });

  return router;
}
