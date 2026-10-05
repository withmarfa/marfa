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
  edgeTripleFields,
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
import { requestBlobProof } from "./_blob-reach.js";
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
    current: EdgeSchema.describe(
      "The edge as it stands now. Merge your change over it and try again.",
    ),
  })
  .describe("A stale update's answer: the refusal and the current edge.")
  .openapi("EdgeVersionConflict");

const MAX_EDGE_TYPE_FILTER = 10;

/** The 400 of the two listings of one item's edges. */
const LISTING_REFUSED =
  "a query parameter is unknown or invalid, or `edge_type` names more than 10 edge types";

/** The 403 the edge-type half of an edge write answers, on `PATCH` and
 *  `DELETE`, where an edge type the key can't read answers `404`. */
const EDGE_TYPE_WRITE_REFUSED =
  "- `edge_permission_denied`: you can read the edge type but don't have write on it. `details.grant` names the missing grant.";

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
    "Returns the edges you can read, newest first, whether or not the items they join are in the trash. A deleted edge doesn't appear here: `GET /events` reports deletions.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe(
          "Only return edges of these edge types, comma-separated, up to 10.",
        ),
      updated_after: z
        .string()
        // Non-empty for the same reason as the item listing: this
        // parameter chooses the ordering, so an empty value would order
        // for a catch-up and bound nothing.
        .min(1)
        .optional()
        .describe(
          "Only return edges that changed at or after this RFC 3339 time. Orders results by `updated_at`, then `id`, ascending, and a cursor from the default order doesn't continue it. Edges can share a time, so deduplicate by `id`.",
        ),
      updated_before: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only return edges that changed before this RFC 3339 time. It doesn't change the order.",
        ),
      limit: pageLimit({ max: 500 }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgePageSchema } },
      description: "Returns a page of edges.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "- `validation_error`: a query parameter is unknown or invalid, `edge_type` names more than 10 edge types, or `cursor` came from the other order.",
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
  },
});

const createEdgeRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createEdge",
  tags: ["Edges"],
  summary: "Create an edge",
  description:
    "Creates an edge between two existing items. Repeating an `id` you already created returns the stored edge with `acknowledged: true` and writes nothing.",
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
                "A UUIDv7 you choose for the edge. Leave it out and Marfa creates one.",
              ),
            ...edgeTripleFields,
            properties: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("The edge's properties. Leave it out for none."),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              edge: EdgeSchema.describe("The stored edge."),
              acknowledged: z
                .boolean()
                .describe("Always `true`: Marfa wrote nothing."),
            })
            .describe("A repeated create's answer: the stored edge."),
        },
      },
      description:
        "Returns the stored edge with `acknowledged: true`. `id` repeats a create you made with the same source, target and edge type, so Marfa wrote nothing and sent no event.",
    },
    201: {
      content: {
        "application/json": { schema: EdgeResponseSchema },
      },
      description: "Returns the new edge.",
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
        "- `missing_required_field`: `source_id`, `target_id` or `edge_type` is missing.\n- `invalid_id`: `source_id`, `target_id` or `id` isn't a valid ID.\n- `validation_error`: a field is invalid, such as an `in-folder` edge's `path`.\n- `edge_constraint_violation`: the edge exists (`details.constraint` is `duplicate`) or breaks a rule of its edge type.\n- `edge_cycle`: the edge would close a cycle.",
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
        "- `edge_permission_denied`: you don't have write on the edge type. `details.grant` names the missing grant.\n- `type_not_permitted`: you can read the source item's type but don't have write on it, or your credential reaches no type. `details.grant` names the missing grant.",
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
        "- `item_not_found`: the source or target doesn't exist, or its type is one you can't read.\n- `edge_type_not_found`: the edge type doesn't exist.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["id_reused"]),
        },
      },
      description:
        "`id_reused`: `id` belongs to a different edge. `details.differs` lists which of `source_id`, `target_id` and `edge_type` differ. If you can't read that edge, only `details.existing_id` is set.",
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
  request: {
    params: z.object({ id: z.string().describe("The ID of the edge.") }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: EdgeResponseSchema },
      },
      description: "Returns the edge.",
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
          schema: makeErrorResponseSchema(["edge_not_found"]),
        },
      },
      description:
        "`edge_not_found`: no edge has this ID, or its edge type or source item's type is one you can't read.",
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
    "Merges properties into an edge, or moves one of its ends, and returns it. A property you leave out stays. Sending `null` stores a null, so you can add properties but not remove them.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({ id: z.string().describe("The ID of the edge.") }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            properties: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                "Properties to merge over the edge's. Required unless an end moves.",
              ),
            source_id: z
              .string()
              .optional()
              .describe(
                "The ID of the source item to move the edge to. Only for an edge type where each target holds one edge (`one-to-one`, `one-to-many`). An update moves one end at a time.",
              ),
            target_id: z
              .string()
              .optional()
              .describe(
                "The ID of the target item to move the edge to. Only for an edge type where each source holds one edge (`one-to-one`, `many-to-one`). An update moves one end at a time.",
              ),
            version: z
              .number()
              .int()
              .min(0)
              .describe(
                "The version of the edge your change is based on, from a read. If the edge has moved on, the update fails with `version_conflict`.",
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
      description:
        "Returns the updated edge. A move keeps the edge's ID and properties, and sends one `edge.updated` event.",
    },
    409: {
      content: {
        "application/json": { schema: EdgeConflictSchema },
      },
      description:
        "`version_conflict`: `version` is stale. `current` holds the edge as it stands.",
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
        "- `missing_required_field`: `version` is missing, or `properties` is missing and no end moves.\n- `validation_error`: the body moves both ends, the edge type can't move an end this way, or a property is invalid.\n- `invalid_id`: `source_id` or `target_id` isn't a valid ID.\n- `edge_constraint_violation`, `edge_cycle`: the moved edge would break its edge type's rules.",
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
      description: `${EDGE_TYPE_WRITE_REFUSED}\n- \`type_not_permitted\`: you can read the source item's type, or the new source's, but don't have write on it, or your credential reaches no type. \`details.grant\` names the missing grant.`,
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
        "- `edge_not_found`: no edge has this ID, or its edge type or source item's type is one you can't read.\n- `item_not_found`: the item you move the edge to doesn't exist or is of a type you can't read, or the end that stays is in the trash.\n- `edge_type_not_found`: you move an end of an edge whose edge type is no longer registered.",
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
    "Deletes an edge and leaves the items it joined as they are. The edge type's `cascade_on_delete` applies when you delete an item, not an edge.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({ id: z.string().describe("The ID of the edge.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns `ok: true`.",
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
      description: `${EDGE_TYPE_WRITE_REFUSED}\n- \`type_not_permitted\`: you can read the source item's type but don't have write on it, or your credential reaches no type. \`details.grant\` names the missing grant.`,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["edge_not_found"]),
        },
      },
      description:
        "`edge_not_found`: no edge has this ID, another request already deleted it, or its edge type or source item's type is one you can't read.",
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
          blob_proof: requestBlobProof(c, storage),
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
          requestBlobProof(c, storage),
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
    "Returns the edges that start at an item. An item in the trash still lists its edges. `GET /items/{id}/backrefs` lists the edges that point at it.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({ id: z.string().describe("The ID of the item.") }),
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe(
          "Only return edges of these edge types, comma-separated, up to 10.",
        ),
      limit: pageLimit({ max: 500 }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgePageSchema } },
      description: "Returns a page of the item's outbound edges.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "validation_error"]),
        },
      },
      description: `- \`invalid_id\`: the ID is not a valid item ID.\n- \`validation_error\`: ${LISTING_REFUSED}.`,
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
    "Returns the edges that point at an item. An item in the trash still lists its edges. `GET /items/{id}/edges` lists the edges that start at it.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({ id: z.string().describe("The ID of the item.") }),
    query: z.object({
      edge_type: z
        .string()
        .optional()
        .describe(
          "Only return edges of these edge types, comma-separated, up to 10.",
        ),
      limit: pageLimit({ max: 500 }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: EdgePageSchema } },
      description: "Returns a page of the item's inbound edges.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "validation_error"]),
        },
      },
      description: `- \`invalid_id\`: the ID is not a valid item ID.\n- \`validation_error\`: ${LISTING_REFUSED}.`,
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
