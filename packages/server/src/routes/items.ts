import {
  ITEM_NOT_FOUND,
  READ_REFUSED,
  WRITE_REFUSED,
} from "./_item-refusals.js";
import { createRoute, z } from "@hono/zod-openapi";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../page-limits.js";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  isValidTimestamp,
  isValidTypeIdentifier,
  getTypeSchema,
  getEdgeTypeSchema,
  validateProperties,
  SYSTEM_DEFAULT_STATE,
  validateTransition,
  hasBoundedLifecycle,
  softDeleteState,
  resolveEnforcement,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type {
  AncestorUnavailableResponse,
  ApiKey,
  ConflictResponse,
  Edge,
  Item,
  ItemState,
  Metadata,
} from "@withmarfa/shared";
import {
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "../storage/merge-properties.js";
import { log } from "../middleware/logger.js";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import {
  requireAuth,
  requirePermission,
  requireTypeAccess,
  requireReadableRow,
  mayReadRow,
  mayWriteEdge,
  requireResolvedRowWrite,
  itemProvenanceSource,
  requireDeclaredTypeMatches,
  checkTypeAccess,
  checkTypePermission,
  requireEdgePermission,
  getTypeFilter,
  mayReadEdgeEnd,
  mayReadType,
} from "../middleware/auth.js";
import type {
  Storage,
  ItemSortField,
  ResolvedItem,
} from "../storage/interface.js";
import { ITEM_EDGES_CURSOR_KEY } from "../storage/interface.js";
import { staleVersion } from "../storage/conflict.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { planCascadeDelete } from "../storage/edge-cascade.js";
import {
  assertEdgesCanBeCreated,
  edgeTargetNotFound,
} from "../storage/edge-constraints.js";
import { publish, publishEdge } from "../pubsub.js";
import { excludesSystemTypes } from "./_system-type-visibility.js";
import { MAX_TAGS_PER_ITEM } from "../tag-limits.js";
import {
  hydrateEdgesForItem,
  hydrateEdgesForItems,
  hydrateBackrefsForItem,
  groupAndCap,
  HYDRATE_PER_TYPE_CAP,
} from "./_edges-hydrate.js";
import { applyInlineEdges, announceInlineEdges } from "./_edges-inline.js";
import { itemAfterMetadataWrite } from "./_metadata-publish.js";
import { undeclaredPropertyRefusal } from "./_undeclared-property.js";
import { sourceAllowlistRefusal } from "./_source-allowlist.js";
import {
  assertFilterEdgeTermsReadable,
  readableEdges,
} from "./_edge-visibility.js";
import { withCascadeMarks } from "./_cascade-marks.js";
import type { InlineEdgeChanges } from "./_edges-inline.js";
import { assertTierApplicable } from "./_tier-rules.js";
import { hydrateExtensionsForItems } from "./_extensions-hydrate.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import {
  ItemSchema,
  ItemWithMetadataSchema,
  ItemDetailSchema,
  MetadataResponseSchema,
  MergePolicySchema,
  MergeStrategyEnum,
  TierEnum,
  VersionConflictErrorSchema,
  ALL_STATES,
  pageOf,
  resolveStateFilter,
} from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";
import { refuseUnlessUninstalled } from "./_connection-refusal.js";
import { itemsLifecycleRoutes } from "./items-lifecycle.js";
import { itemsVersionsRoutes } from "./items-versions.js";
import {
  refuseUnknownQueryParams,
  UNKNOWN_PARAM_NOTE,
} from "./_unknown-query-keys.js";

/**
 * The `?edge[<type>]=<id>` / `?backref[<type>]=<id>` shorthand keys.
 *
 * Declared once because two things read it: the clause builder that
 * compiles a match into the filter grammar, and the unknown-parameter
 * refusal, which would otherwise reject every one of them. Two copies of
 * this pattern would mean a working shorthand starting to answer 400 the
 * moment one of them changed.
 */
const EDGE_SHORTHAND_KEY = /^(edge|backref)\[([^\]]+)\]$/;

// ---------------------------------------------------------------------------
// Reusable schemas (Item / Metadata / ItemWithMetadata live in _schemas.ts;
// imported above. The conflict-response schemas are local to items.ts since
// no other route uses them.)
// ---------------------------------------------------------------------------

const ConflictSnapshotSchema = z
  .object({
    // The row, because a create names a natural key and not an id: refused
    // here, it learns which row the key resolved from this and nothing else.
    id: z.string(),
    version: z.number(),
    properties: z.record(z.string(), z.unknown()),
    // The version check covers these three beside the properties, so a
    // collision can name one; without them here the refusal names a field
    // the caller has no way to read either side of.
    tier: TierEnum,
    occurred_at: z.string(),
    source_id: z.string().nullable(),
    // And the type, because a stale move onto a row moved since collides
    // on it: the refusal shows the type the row has and the one the
    // caller read.
    type: z.string(),
  })
  .openapi("ConflictSnapshot");

export const ConflictResponseSchema = z
  .object({
    error: VersionConflictErrorSchema,
    current: ConflictSnapshotSchema,
    ancestor: ConflictSnapshotSchema,
    conflicting_fields: z.array(z.string()),
    merge_policy: MergePolicySchema,
  })
  .openapi("ItemVersionConflict");

/**
 * The refusal for a stale write that carried nothing to merge.
 *
 * `current` and `error.status` are here because every `version_conflict`
 * carries them, whichever door answered and whatever the write held. What is
 * absent is what a merge would need and this write has none of: there is no
 * ancestor to compare against and no field that could have collided.
 */
const StaleVersionSchema = z
  .object({
    error: VersionConflictErrorSchema,
    current: ConflictSnapshotSchema,
  })
  .openapi("ItemStaleVersion");

/**
 * The refusal for a write based on a version whose snapshot has been thinned
 * away. Distinct from `version_conflict` because it cannot be resolved: there
 * is no ancestor, so no field can be shown not to have collided, and a client
 * merging against an empty one spawns siblings holding text nobody typed.
 */
export const AncestorUnavailableSchema = z
  .object({
    error: z
      .object({
        code: z.literal("ancestor_unavailable"),
        status: z.literal(409),
        message: z.string(),
      })
      .openapi("AncestorUnavailableError"),
    current: ConflictSnapshotSchema,
    requested_version: z.number(),
  })
  .openapi("ItemAncestorUnavailable");

/**
 * Who resolves a collision on this write.
 *
 * A closed enum rather than a free string, so a caller asking for a mode this
 * server does not implement is refused. Dropping it instead would answer 409
 * to a request that asked for a resolution, which reads as "no conflict was
 * resolvable" rather than "nobody read your parameter".
 */
const ConflictModeSchema = z
  .enum(["auto", "manual", "callback"])
  .openapi("ConflictMode");

/**
 * The 200 for an update, widened by what the server did if it resolved a
 * collision. Absent on every write that did not, which is nearly all of them.
 */
const UpdatedItemSchema = ItemWithMetadataSchema.extend({
  conflict_resolution: z
    .object({
      fields: z.array(z.string()),
      strategy: z.record(z.string(), MergeStrategyEnum),
      conflicted_copy_id: z.string().optional(),
    })
    .optional()
    .describe(
      "What the server did, present only when this write resolved a " +
        "conflict. `conflicted_copy_id` names the sibling carrying the " +
        "losing values — the only place it is reported, since no route " +
        "says what a write created.",
    ),
});

const IdParam = z.object({
  id: z.string().describe("Item id"),
});

/**
 * Upper bound on neighbors hydrated by `GET /items/:id?include=neighbors`.
 * Outbound + inbound edges are each already capped per type
 * (`HYDRATE_PER_TYPE_CAP`), so this only bites a pathological cross-product of
 * many edge types; overflow neighbors stay reachable through the per-type
 * edge/backref endpoints. Matches the bulk-get id cap so one detail read can
 * never exceed one batched hydration.
 */
const MAX_NEIGHBOR_IDS = 100;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createItemRoute = createRoute({
  operationId: "createItem",
  method: "post",
  path: "/",
  tags: ["Items"],
  summary: "Create an item",
  description:
    "Creates an item, validating its properties against the registered type schema before the write; a schema failure rejects the whole item. The server stamps identity, timestamps, version and `source`: the credential's own, or one the credential's key claims when the body names it, and a body naming any other source is refused `403 forbidden` with `details.source`. Passing a `source_id` that already exists under that source upserts the existing item and returns 200 instead of 201, whichever credential wrote it, so two keys claiming one source share its natural keys. Passing an `id` the caller already created is treated the same way: the create is a repeat of one the server has performed, so nothing is written, no event is published, and the stored item comes back with `acknowledged: true`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            type: z.string(),
            properties: z.record(z.string(), z.unknown()).optional(),
            id: z.string().optional(),
            state: z.string().optional(),
            occurred_at: z.string().optional(),
            source: z
              .string()
              .optional()
              .describe(
                "The source this row is keyed by and stamped with. Omitted, or naming the credential's own, takes the credential's; naming one of its key's `sources` takes that one; anything else is refused `403 forbidden`. A row's source never moves afterwards.",
              ),
            source_id: z.string().optional(),
            version: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                "Optional, and meaningful on one path: a `source_id` resolving a live row makes this write an upsert, and a version here makes that upsert conditional exactly as it is on the update door. Everywhere else it is ignored, because nothing is overwritten — a genuine create has no version to have read, and a repeated `id` or a natural key resolving a trashed row is acknowledged rather than written.",
              ),
            tier: TierEnum.optional(),
            capture_latitude: z.number().optional(),
            capture_longitude: z.number().optional(),
            tags: z.array(z.string()).optional(),
            // Atomic item + edges write: for each edge type, the listed
            // item ids become targets with the new item as source. Rejects
            // all-or-nothing if any constraint violation surfaces.
            edges: z.record(z.string(), z.array(z.string())).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description:
        "The request resolved an item that already exists, by one of two " +
        "keys, and there are three answers. **Natural-key upsert:** both " +
        "`source` (the credential's own, or one its key claims that the " +
        "body names) and request `source_id` " +
        "resolve a live item, and it is updated in " +
        "place — an idempotent re-sync of the upstream entry. " +
        "**Acknowledged re-sync:** the same natural key resolves an item " +
        "the user has trashed, so the response carries `acknowledged: true` " +
        "and nothing is written; the deletion stands rather than the " +
        "re-sync being refused forever. **Acknowledged repeat:** the " +
        "request carries an `id` the caller already created, so the create " +
        "is a second arrival of that client's own write; the stored row " +
        "comes back with `acknowledged: true`, in whatever state it holds " +
        "including trashed, and nothing is written or published. On every " +
        "one of the three the resolved item's `type` decides the shape, so " +
        "a request naming a different one is refused with 409 " +
        "`type_mismatch` rather than reinterpreted.",
    },
    201: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description: "Item created",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "unknown_type",
            "invalid_id",
            "invalid_properties",
            "edge_constraint_violation",
            "edge_cycle",
          ]),
        },
      },
      description: "Validation error",
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
            "forbidden",
            "type_not_permitted",
            "edge_permission_denied",
          ]),
        },
      },
      description:
        "`forbidden`: the body named a `source` the credential's key does not claim, named in `details.source`, or a source allow-list excludes the source. `type_not_permitted` and `edge_permission_denied`: the credential holds no write on the item's type or on an inline edge's type, or on the type of the row the natural key resolves; where it may not read that type, the refusal names nothing of the row.",
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
        "An inline edge names an edge type that does not exist, or a target that does not exist or whose type the caller may not read; the two targets answer alike.",
    },
    409: {
      content: {
        "application/json": {
          schema: z.union([
            ConflictResponseSchema,
            AncestorUnavailableSchema,
            makeErrorResponseSchema([
              "conflict",
              "id_reused",
              "link_taken",
              "type_mismatch",
            ]),
          ]),
        },
      },
      description:
        "`link_taken`: the type names a `link_field`, and another item of " +
        "the type, in any state, holds the value this write gives the " +
        "row; `details.existing_id` names it. " +
        "`id_reused`: the `id` this request minted is taken by an item it " +
        "is not describing, and `details.differs` names what disagrees. " +
        "`POST /edges` answers the same code for an id naming a different " +
        "triple. `type_mismatch`: the request resolved an existing item by " +
        "the `(source, source_id)` natural key and declared a type that " +
        "row is not — the id was never in question, the declaration was. " +
        "Re-typing an item is a deliberate " +
        "operation, not something a re-sync does in passing. `conflict`: " +
        "the `id` is held by an item this caller cannot read, so the " +
        "server cannot tell it is a repeat of this caller's own create " +
        "and will not overwrite it blind. `version_conflict` and `ancestor_unavailable` are " +
        "reachable only when the request carried a `version` and its " +
        "`source_id` resolved a live row: that upsert is conditional and " +
        "answers exactly what the update door answers. A repeated `id` is " +
        "acknowledged rather than written, so it has no precondition to fail.",
    },
  },
});

const getItemStatsRoute = createRoute({
  operationId: "getItemStats",
  method: "get",
  path: "/stats",
  tags: ["Items"],
  summary: "Get item counts",
  description:
    "Returns a count of items, grouped on one axis. `by=state` (the default) counts per lifecycle state; `by=type` names the types actually in use, which is otherwise unanswerable without paging every row. Both groupings cover the same rows, so their totals agree. The counts are scoped to the caller's type permissions, so a credential sees only the types it can read.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      by: z
        .enum(["state", "type"])
        .optional()
        .describe("Grouping axis. Defaults to `state`."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.number()),
        },
      },
      description: "Item counts by state",
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
        "The credential's type permissions reach no type, so there is nothing on the data plane it may read. A credential that reaches some types reads this door narrowed to them rather than being refused.",
    },
  },
});

const listItemsRoute = createRoute({
  operationId: "listItems",
  method: "get",
  path: "/",
  tags: ["Items"],
  summary: "List items",
  description: `Returns a paginated list of items, narrowed by the query parameters; a \`type\` filter matches subtypes via inheritance. Lists are lean by default — use \`include\` to hydrate edges, metadata, or extensions inline and avoid an N+1. That same parameter also takes \`system\`, which is not a hydration: it widens the rows returned to include \`system.*\` items, which this listing omits by default. Every edge carried on a response is held to the two permissions \`GET /edges/{id}\` asks for: read on the source item's type, and read on the edge type. A block whose edges all fail is left out rather than returned empty, so a response can carry fewer kinds of relationship than the item has. ${UNKNOWN_PARAM_NOTE}`,
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z
        .string()
        .optional()
        .describe(
          "Type identifier; matches subtypes via inheritance. A concrete identifier this instance does not know is refused with 400 `unknown_type`; a wildcard over nothing answers an empty page.",
        ),
      state: z
        .string()
        .optional()
        .describe(
          `Filter by lifecycle state. Omitting the parameter answers the active state, which is what a reader is working with. \`${ALL_STATES}\` returns every state in one pass, which a resuming client needs in order to see a row leave the active state.`,
        ),
      source: z
        .string()
        .optional()
        .describe("Narrow to rows stamped with this `source`."),
      tier: z
        .enum(["library", "feed", "all"])
        .optional()
        .describe("Tier slice; omit or `all` returns both"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated tags; items must carry all of them"),
      filter: z
        .string()
        .optional()
        .describe(
          "Filter expression in the query grammar. A term naming an edge " +
            "type — `edge[<type>]` or `backref[<type>]`, in this " +
            "parameter or as the `edge[<type>]=<id>` shorthand — asks " +
            "about a relationship, so it is held to the edge read " +
            "permission: one naming a type the credential may not read is " +
            "refused `403 edge_permission_denied`. A `backref` term " +
            "counts only edges whose source the credential may read, so " +
            "one anchored on an item it may not read matches as one " +
            "anchored on an id no row holds; an `edge` term matches every " +
            "edge it may read, one to an item it may not read included.",
        ),
      sort: z
        .string()
        .regex(
          /^(created_at|updated_at|occurred_at|properties\.[a-z0-9_]+)$/,
          "sort must be created_at, updated_at, occurred_at, or properties.<field>",
        )
        .optional()
        .describe(
          "Field to sort by: a system column (created_at, updated_at, occurred_at) or a naturally-orderable custom field via properties.<field> (e.g. properties.due_at). Enum fields like status/priority are not sortable here — their order is semantic, not lexical.",
        ),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      occurred_after: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Lower bound on the item's own time — `occurred_at`, falling back to `created_at` (exclusive). An RFC 3339 instant in any valid spelling; it is normalized before the comparison. Not the modification time; for that use `updated_after`.",
        ),
      occurred_before: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Upper bound on the item's own time — `occurred_at`, falling back to `created_at` (exclusive).",
        ),
      updated_after: z
        .string()
        // Non-empty, because the ordering switches on this parameter
        // rather than on `sort`: an empty value would order by
        // `(updated_at, id)` ascending and bound nothing, so a client
        // building the query before it holds a cursor would walk the
        // whole corpus under the shape of a narrow catch-up.
        .min(1)
        .optional()
        .describe(
          "Lower bound on `updated_at`, when the row last changed (inclusive). The catch-up filter: pass the cursor you hold to get everything that changed since. Forces `(updated_at, id)` ascending order, so `sort` and `direction` cannot also be given, and a cursor issued under one ordering is refused under the other. Inclusive because `updated_at` ties across a bulk write, so deduplicate by id — and note that a high-water mark landing on an instant a large bulk write shares means that whole group is re-sent on every reconnect, which terminates but is not free. This read reports changes, never removals: a purge leaves no row behind, so pruning a local copy needs the event stream as well.",
        ),
      updated_before: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Upper bound on `updated_at` (exclusive), closing the window its lower twin opens. Exclusive where `updated_after` is inclusive, because this is an end point the caller chooses rather than a resume point that must not drop a tie. It does not change the ordering, so it may be given under any sort.",
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .optional()
        .default(DEFAULT_PAGE_LIMIT)
        .describe(
          `Page size, ${String(MIN_PAGE_LIMIT)}–${String(MAX_PAGE_LIMIT)} (default ${String(DEFAULT_PAGE_LIMIT)})`,
        ),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a prior response"),
      include: z
        .string()
        .optional()
        .describe(
          "Comma-separated tokens. `edges`, `metadata` and `extensions` hydrate " +
            "those extras inline on the rows already being returned. `system` is " +
            "different in kind: it widens the row set, opting in `system.*` items, " +
            "which are excluded by default. A `type` filter in the `system.` " +
            "namespace, concrete or wildcard, opts in on its own without the " +
            "token.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(
            z
              .union([ItemSchema, ItemWithMetadataSchema])
              .describe(
                "An `Item`, or, when `include` names `metadata`, an `ItemWithMetadata`; every row of one page is the same shape.",
              )
              // `oneOf`, not the `anyOf` a union gets by default: the two
              // shapes share no required key, so a row is exactly one of
              // them, and a generator reads `anyOf` as one object holding
              // both shapes' required keys, which no row has.
              .openapi("ItemListRow", {}, { unionPreferredType: "oneOf" }),
            "ItemPage",
          ),
        },
      },
      description: "Paginated list of items",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "unknown_type",
          ]),
        },
      },
      description: "Validation error",
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
        "`type_not_permitted` when the credential's type permissions reach no type, so there is nothing on the data plane it may read. A credential that reaches some types reads this door narrowed to them rather than being refused. `edge_permission_denied` when an `edge` or `backref` term names an edge type the credential may not read.",
    },
  },
});

const getItemRoute = createRoute({
  operationId: "getItem",
  method: "get",
  path: "/{id}",
  tags: ["Items"],
  summary: "Get an item",
  description:
    "Returns a single item with its metadata layer and outbound edges hydrated inline; extensions are not included. A row that is not stored answers 404, and so does a row whose type the credential's type map does not reach, with the same code and message, so the answer says nothing of whether the row exists or what type it is. A credential whose map reaches no type at all is refused `403 type_not_permitted`, whatever the id names.\n\n" +
    "`?include=` widens the response with the item's 1-hop neighborhood in one round trip instead of a per-section fan-out: `backrefs` adds inbound edges grouped by type (same block shape as `edges`, capped + cursored per type); `neighbors` adds the far-end items of the item's edges (outbound targets, plus inbound sources when `backrefs` is also requested), each with its metadata and filtered to what the caller may read; `versions` adds the item's version snapshots, oldest first. Tokens are comma-separated and compose.\n\n" +
    "Every edge carried on a response is held to the two permissions `GET /edges/{id}` asks for: read on the source item's type, and read on the edge type. A block whose edges all fail is left out rather than returned empty, so a response can carry fewer kinds of relationship than the item has.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      include: z
        .string()
        .optional()
        .describe(
          "Comma-separated extras to hydrate inline: backrefs, neighbors, versions.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ItemDetailSchema },
      },
      description: "Item with metadata, and any requested neighborhood blocks",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "The id is not a well-formed item id.",
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
      description: ITEM_NOT_FOUND,
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

const updateItemRoute = createRoute({
  operationId: "updateItem",
  method: "patch",
  path: "/{id}",
  tags: ["Items"],
  summary: "Update an item",
  description:
    "Updates an item's properties, tier, own time, edges, or natural key. Properties merge shallowly with existing values by default; when `properties_mode` is `replace` the body is the whole of the caller's properties, so a field it leaves out is cleared. `version` is required, and a write naming none is refused 400 `missing_required_field`. At the current version the write lands as sent. At a stale one the caller's genuine changes, a cleared field included, merge over the row where nothing collides, and a collision on a property, `tier`, `occurred_at` or `source_id` answers 409 with the conflict context to resolve, or is resolved by the type's merge policy under `?conflict=auto`. An item's `type` is not updatable here by default: sending one that matches the item is accepted and ignored, and sending a different one is refused with 409 `type_mismatch` rather than silently dropped. Passing `retype: true` alongside a different `type` moves the item to it, with or without `properties`, and at a stale version as at the current one where nothing collides; a type nothing registered is refused `400 unknown_type` as a create refuses it, the properties the row ends up with are held to the type it enters, `400 invalid_properties` where they fall short, and a colliding stale move answers 409 whatever `?conflict` asks, a move onto a row another writer moved since colliding on `type`; that requires write on the type being entered as well as the one being left. `retype` naming the type the row already has changes nothing and takes no version step. Where the instance's strict-mode lever names the type, a property the type does not declare is refused `400 invalid_properties` with `details.code` `unknown_property`, judged on the properties this request carries.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      conflict: ConflictModeSchema.optional().describe(
        "Who resolves a version conflict. `auto` resolves it here, in this " +
          "write's transaction, by the type's merge policy: a " +
          "`last_writer_wins` field takes this write's value, a " +
          "`keep_both_copies` field leaves the server's value on the item " +
          "and the losing value lands on a sibling tagged `conflicted-copy` " +
          "beside the original's tags, with a copy of the edges that are the " +
          "original's own, those its own file would write, that a second " +
          "item may hold and the writer could have made. The sibling " +
          "carries neither the item's natural key nor its link, so where " +
          "the type requires its `link_field`, itself or through a parent, " +
          "nothing is resolved and the " +
          "write answers the 409 envelope. " +
          "`manual` and `callback` return the 409 envelope for the caller to " +
          "resolve. Omitted means `manual`.",
      ),
    }),
    body: {
      content: {
        "application/json": {
          /** Strict, so a key this door does not declare is refused rather
           *  than dropped. A dropped key is a request half-performed and
           *  answered `200`, which is what a caller reads as the whole of
           *  it having landed; the listing grammar refuses an undeclared
           *  query key for the same reason. `.strict()` does not recurse,
           *  and `properties` is deliberately open: its keys are the
           *  type's, not this door's. */
          schema: z.strictObject({
            properties: z.record(z.string(), z.unknown()).optional(),
            /** The item's own type, and only that. This route does not
             *  re-type the row it addresses, so the field exists to be
             *  checked rather than applied: equal to the item's type it is
             *  accepted and ignored, anything else is refused.
             *
             *  Present in the schema at all because callers send it
             *  constantly. The fleet builds one input object and hands it
             *  to either the create or the update call, so a type rides on
             *  nearly every reactive update. Stripped in silence, a re-type
             *  could be attempted, answered with a 200, and do nothing. */
            type: z.string().optional(),
            /** Whether `properties` lays over the item's or becomes them.
             *  Defaults to `merge`, so a write that names no mode can never
             *  remove a property it did not mention. A `replace` says the
             *  set sent IS the caller's properties, so a field it leaves out
             *  is cleared: at the current version outright, at a stale one
             *  where nobody changed it since, and colliding where somebody
             *  did. The result is validated either way, so a replace
             *  dropping a required field is refused rather than written. */
            properties_mode: z.enum(["merge", "replace"]).optional(),
            /** Move the item to the `type` named above.
             *
             *  An explicit opt-in rather than an inference from `type`
             *  differing, because the fleet sends a type on nearly every
             *  reactive update: a route that re-typed whenever the two
             *  disagreed would move a corpus on somebody's ordinary sync
             *  bug. Without this the disagreement is refused, which stays
             *  the default and is what a caller who has not thought about
             *  it gets.
             *
             *  Exists for one job: bringing items written under one shape
             *  onto the shape a person's mapping now names. Otherwise a
             *  mapping applies only to what arrives next and everything
             *  already there is stranded under the old type. */
            retype: z.boolean().optional(),
            version: z
              .number()
              .int()
              .min(0)
              .describe(
                "The version the caller read. Required: an update carries the version it is based on, or it is not an update but a blind overwrite of whatever arrived since.",
              ),
            /** Toggle the tier (`library` ↔ `feed`). Compared against the
             *  version named like a property, so a stale flip collides with
             *  one made since. */
            tier: TierEnum.optional(),
            /** Override the item's own time (ISO 8601). Compared against
             *  the version named like `tier`. */
            occurred_at: z.string().optional(),
            /** Repoint at a new natural-key identifier under the item's
             *  own `source`, which this door never moves. The
             *  `(source, source_id)` tuple is
             *  unique — the server returns 409 `source_id_conflict`
             *  if another item already holds the target value. Idempotent
             *  no-op when the value matches the row's current source_id.
             *  Repointing the natural key is how renames preserve item
             *  continuity without creating a new row. */
            source_id: z.string().optional(),
            // Replace-all-for-specified-types semantics: any edge_type
            // listed wipes existing outbound edges of that type from
            // this item, then creates new edges to each listed target.
            // Empty array for an edge_type deletes all of that type.
            // Unmentioned edge types are untouched.
            edges: z.record(z.string(), z.array(z.string())).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: UpdatedItemSchema },
      },
      description: "Item updated",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
            "invalid_properties",
            "unknown_type",
            "edge_constraint_violation",
            "edge_cycle",
          ]),
        },
      },
      description: "Validation error",
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
        "`type_not_permitted` when the credential may read the item's type and does not hold write on it, or reaches no type; `edge_permission_denied` when the body's `edges` name an edge type it does not hold write on.",
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
      description: `${ITEM_NOT_FOUND} An inline edge naming an edge type that does not exist answers \`edge_type_not_found\`, and one naming a target that does not exist or whose type the caller may not read answers \`item_not_found\`, the two targets alike.`,
    },
    409: {
      content: {
        "application/json": {
          schema: z.union([
            ConflictResponseSchema,
            StaleVersionSchema,
            AncestorUnavailableSchema,
            // No bare `version_conflict` here. Every one this route answers
            // is one of the three envelopes above, and declaring a fourth
            // shape nothing produces is a client's excuse for handling it.
            makeErrorResponseSchema([
              "link_taken",
              "source_id_conflict",
              "type_mismatch",
            ]),
          ]),
        },
      },
      description:
        "Version conflict — a stale `version`, whether the write carried properties to merge or only edges, `ancestor_unavailable` (the base version's snapshot has been thinned, so the write cannot be merged and is never auto-resolved), `source_id_conflict` (target natural key already in use by another item under the item's `source`), `link_taken` (the properties the row ends up with, in the type it ends up as, hold a link another item of that type holds in any state, named in `details.existing_id`; judged at a stale version on the merge as it lands), or `type_mismatch` (the request declared a `type` that is not this item's).",
    },
  },
});

const deleteItemRoute = createRoute({
  operationId: "deleteItem",
  method: "delete",
  path: "/{id}",
  tags: ["Items"],
  summary: "Soft delete an item",
  description:
    "Moves the item to the trashed state, reversible via restore until the retention window expires, after which it is purged permanently. For immediate, irreversible removal use the purge endpoint instead. Every row a cascading edge such as `parent-of` takes into the bin with it carries `trashed_by_cascade`, and `trashed_with` naming this item to a caller that may read its type, and its `item.deleted` frame says so too. A live `system.connection` is refused: an app grant is revoked through the grants routes first, so its tokens and stored consent go with it.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description: "Item trashed",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_constraint_violation",
            "invalid_id",
            "validation_error",
          ]),
        },
      },
      description:
        "`invalid_id` for a malformed id. `edge_constraint_violation` when an edge type the item is an end of declares `cascade_on_delete: block` and such an edge exists. `validation_error` when the item is a live `system.connection`: revoke the app grant through `DELETE /auth/grants/{id}` first, because removing the row here would leave the app's tokens and stored consent behind with nothing naming their owner.",
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
      description: WRITE_REFUSED,
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

/** The type gate every metadata and tag door runs on the item's type. */
function metadataTypeRefusal(level: "read" | "write") {
  return {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["type_not_permitted"]),
      },
    },
    description: level === "read" ? READ_REFUSED : WRITE_REFUSED,
  };
}

const getMetadataRoute = createRoute({
  operationId: "getItemMetadata",
  method: "get",
  path: "/{id}/metadata",
  tags: ["Metadata"],
  summary: "Get item metadata",
  description:
    "Returns the metadata layer for one item without fetching the full item. For bulk reads, list items with the metadata include to hydrate it across a page instead.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Item metadata",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "Invalid item ID",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("read"),
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

const putMetadataRoute = createRoute({
  operationId: "replaceItemMetadata",
  method: "put",
  path: "/{id}/metadata",
  tags: ["Metadata"],
  summary: "Replace item metadata tags",
  description:
    "Replaces the item's tag set with the supplied array, where an empty array clears all tags. Only tags are touched; tier and state are unaffected and change through their own endpoints.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tags: z.array(z.string()).optional().default([]),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Metadata replaced",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
          ]),
        },
      },
      description: "Validation error",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("write"),
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

const patchMetadataRoute = createRoute({
  operationId: "mergeItemMetadata",
  method: "patch",
  path: "/{id}/metadata",
  tags: ["Metadata"],
  summary: "Merge item metadata",
  description:
    "Set-union-merges the supplied tags into the existing tag set, preserving current tags and deduping. Use this to add tags without clobbering ones another source attached; replace the full set through the PUT endpoint instead.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tags: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Metadata merged",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
          ]),
        },
      },
      description: "Validation error",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("write"),
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

const addTagsRoute = createRoute({
  operationId: "addItemTags",
  method: "post",
  path: "/{id}/tags",
  tags: ["Items"],
  summary: "Add tags to an item",
  description:
    "Adds one or more tags to the item. Idempotent — tags already present are not duplicated.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tags: z
              .array(z.string())
              .min(1, "tags must be a non-empty array of strings"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Tags added",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
          ]),
        },
      },
      description: "Validation error",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("write"),
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

const removeTagRoute = createRoute({
  operationId: "removeItemTag",
  method: "delete",
  path: "/{id}/tags/{tag}",
  tags: ["Items"],
  summary: "Remove a tag from an item",
  description:
    "Removes one tag from the item. Idempotent — removing a tag the item doesn't carry returns 200 with the unchanged metadata.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Item id"),
      tag: z.string().describe("Tag to remove (URL-encoded)"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetadataResponseSchema,
        },
      },
      description: "Tag removed",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "Invalid item ID",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: metadataTypeRefusal("write"),
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

const purgeItemRoute = createRoute({
  operationId: "purgeItem",
  method: "delete",
  path: "/{id}/purge",
  tags: ["Items"],
  summary: "Permanently delete an item",
  description:
    "Hard-deletes the item and its edges, metadata, extensions, and attachment references — irreversible, and requires `items.purge` and write on the item's type. Each edge it takes is announced `edge.deleted` with `purged_with` naming this item. Content-addressed blob bytes are retained if other items still reference them; most clients want the soft-delete endpoint instead. A live `system.connection` is refused: an app grant is revoked through the grants routes first, so its tokens and stored consent go with it.\n\nThe purge leaves tombstones under the item's type: its link, where the type names a `link_field` and the row held a value there, and its natural key, where it had one, each with the purge time as `purged_at` and `settled_at`. `POST /items/lookup` reads them and `POST /items/tombstones` moves `settled_at` later; an item that later holds the same link in the type, or the same natural key in any type, removes the one it matches. Nothing else sweeps them but deleting the type.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description: "Item permanently deleted",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "invalid_id",
            "invalid_transition",
            "validation_error",
          ]),
        },
      },
      description:
        "`invalid_id` for a malformed id. `invalid_transition` when the item is not soft-deleted: purging is the hard delete behind a soft one, and the same code the restore door beside it answers for the same class of mistake. `validation_error` when the item is a live `system.connection` — revoke the app grant through `DELETE /auth/grants/{id}` first, because removing the row here would leave the app's tokens and stored consent behind with nothing naming their owner.",
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
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description:
        "`items.purge` is missing; the credential may read the item's type and not write it, asked whatever state the row is in, as restore asks, or reaches no type; or the item is in a reserved namespace and not soft-deleted, which no working credential could have trashed.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description:
        "No such item, including one this door has already purged. An item of a type the credential may not read answers alike.",
    },
  },
});

/** One answer for both re-sent creates, so what it discloses (extension
 *  metadata, a cascade's mark) is decided in one place. */
async function acknowledgedItemBody(
  storage: Storage,
  apiKey: ApiKey,
  existing: Item,
): Promise<{ item: Item; metadata: Metadata; acknowledged: true }> {
  const metadata = await storage.metadata.get(existing.id);
  const [item = existing] = await withCascadeMarks(storage, apiKey, [existing]);
  return {
    item,
    metadata: filterMetadataForCaller(metadata, apiKey),
    acknowledged: true,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * A block refusal listing, and counting, only the blocking edges whose kind
 * and both ends the caller may read, so a hidden holder is never named.
 */
async function withoutHiddenBlockers(
  storage: Storage,
  key: ApiKey,
  err: unknown,
): Promise<unknown> {
  const details = err instanceof MarfaError ? err.details : undefined;
  const blockers = (details as { blocking_edges?: Edge[] } | undefined)
    ?.blocking_edges;
  const root = (details as { root_item_id?: string } | undefined)?.root_item_id;
  if (!(err instanceof MarfaError) || !blockers || !root) return err;
  const readable = await readableEdges(storage, key, blockers);
  const targets = await storage.items.getMany(
    readable.map((edge) => edge.target_id),
    { includeTrashed: true },
  );
  const listed = readable.filter((edge) => {
    const target = targets.get(edge.target_id);
    return target !== undefined && mayReadType(key, target.type);
  });
  return new MarfaError(
    err.code,
    listed.length === 0
      ? `Cannot delete item ${root}: blocked by an edge with cascade_on_delete=block`
      : `Cannot delete item ${root}: blocked by ${String(listed.length)} edge(s) with cascade_on_delete=block`,
    { ...details, blocking_edges: listed },
  );
}

export function itemRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /items — create
  router.openapi(createItemRoute, async (c) => {
    const body = c.req.valid("json");

    const type = body.type;
    if (!type) {
      throw new MarfaError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        "type is required",
        {
          field: "type",
        },
      );
    }
    if (!isValidTypeIdentifier(type)) {
      throw malformedTypeIdentifier("type", `Invalid type identifier: ${type}`);
    }

    const properties = body.properties ?? {};
    if (typeof properties !== "object") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "properties must be an object",
      );
    }

    if (body.id && !isValidId(body.id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    if (body.occurred_at && !isValidTimestamp(body.occurred_at)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid occurred_at");
    }
    // A create is not a transition, so nothing puts it through the graph on
    // its own, and a membership test against the universal state list is a
    // weaker question than the one that matters: `trashed` is a valid state
    // and is not in the `system.*` lifecycle at all. That test alone would
    // let the operator key create a `system.connection` directly in
    // `trashed` (a state no transition can produce and none can leave) and
    // then restore it into `active` having passed nothing the graph admits.
    //
    // Asking `validateTransition` what the default start state can reach
    // gives each type its own answer with no second table to keep in step:
    // a non-system type gets `active | archived | trashed`, a `system.*`
    // type gets `active | revoked`. It also rejects a value that is not a
    // state at all, so no separate check of the state's spelling is needed.
    //
    // **In the route, not in `storage.items.create`**, and the asymmetry
    // with `items.restore()` is deliberate. The store's `create` is also
    // the archive restore's writer, and that door asks the same question
    // of every archived row before it writes any: a create is not a
    // transition, so the gate belongs to the doors that create. The
    // lifecycle gate that DOES belong in the store is the one on
    // `restore()`, because a restore is a transition and its two siblings
    // live there.
    if (body.state && body.state !== SYSTEM_DEFAULT_STATE) {
      const error = validateTransition(
        type,
        SYSTEM_DEFAULT_STATE,
        body.state as ItemState,
      );
      if (error) {
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, error);
      }
    }

    requireTypeAccess(c, type, "write");

    if (Array.isArray(body.tags) && body.tags.length > MAX_TAGS_PER_ITEM) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
      );
    }

    // The enforcement levers: off by default, and set per type by the
    // instance config or a credential's own override.
    const instanceConfig = await readInstanceConfig(storage.settings);
    const enforcement = resolveEnforcement(instanceConfig, c.get("apiKey"));

    // The source the row is keyed by and stamped with: the credential's
    // own, or one its key claims that the body names. A named source it
    // does not claim is refused here, and so is one the type's allow-list
    // excludes, both ahead of the natural-key lookup that runs under it.
    const credential = c.get("apiKey");
    const stampedSource = itemProvenanceSource(credential, body.source);
    const notAllowed = sourceAllowlistRefusal(enforcement, type, stampedSource);
    if (notAllowed) throw notAllowed;

    // Strict-mode lever: when configured for this type, unknown properties
    // are rejected. Storage's own validateProperties runs in loose mode
    // regardless; this pre-check catches strict-mode violations before any
    // persistence work. Shared with the restore door, which writes through
    // the store and so cannot rely on the store to ask.
    const undeclared = undeclaredPropertyRefusal(enforcement, type, properties);
    if (undeclared) throw undeclared;
    // `system.*` items have no tier; reject explicit values on write, and
    // stamp `undefined` rather than the library default.
    //
    // Asked through the same predicate the delete door uses, so the two
    // cannot answer differently for a reserved-root type this build did not
    // seed: one refusing the tier while the other still stamps a default is
    // how a platform record ends up with a field its own lifecycle has no
    // room for.
    // The refusal comes from the shared rule rather than a copy of it: a
    // copy here would be the disagreement between doors `_tier-rules.ts`
    // exists to prevent.
    assertTierApplicable(type, body.tier);
    // Still needed after the refusal, because what a system write stamps is a
    // separate question from what it accepts. What it prevents is inheriting
    // the credential's own default: a key with `default_tier: "feed"` would
    // otherwise put every `system.*` row it writes into the feed.
    //
    // It does not prevent a tier altogether, which the surrounding code reads
    // as though it does. The column is NOT NULL with a `library` default and
    // the store writes `input.tier ?? "library"`, so the row lands on
    // `library` either way and no tier is not a representable state. Whether
    // that matters depends on whether anything reads a system row's tier as a
    // surfacing decision, which is a schema question rather than this door's.
    //
    // Otherwise the body's tier, then the credential's default, then
    // `library`: the curated layer is the default when neither the caller
    // nor the credential says.
    const isSystemTypeWrite = hasBoundedLifecycle(type);
    const tierValue: "library" | "feed" | undefined = isSystemTypeWrite
      ? undefined
      : (body.tier ?? credential?.default_tier ?? "library");

    // Validate edges payload up-front (shape only) so the write path doesn't
    // have to double-check. Per-constraint validation runs inside the
    // transaction against the just-created item.
    if (body.edges) {
      for (const [edgeType, targets] of Object.entries(body.edges)) {
        if (!Array.isArray(targets)) {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `edges.${edgeType} must be an array of item ids`,
          );
        }
        for (const target of targets) {
          if (!isValidId(target)) {
            throw new MarfaError(
              ErrorCode.INVALID_ID,
              `Invalid target id in edges.${edgeType}`,
            );
          }
        }
        // Permission gate: atomic POST /items edges require the same
        // edge-type write permission as POST /edges. Item-type write is
        // already enforced above via requireTypeAccess(type, "write").
        //
        // Gated regardless of target count. On the natural-key upsert
        // branch an empty list reaches `applyInlineEdges`, which reads it
        // as "delete every edge of this type" — so exempting the empty
        // case handed the delete primitive to a caller with no edge
        // permission at all.
        requireEdgePermission(c, edgeType, "write");
      }
    }

    // Natural-key upsert. When both `source` (resolved above) and request
    // `source_id` are present, look up an existing row by
    // (source, source_id). If one matches,
    // short-circuit to update so `POST /items` is idempotent on re-sync —
    // the contract that lets inbound connector handlers recover from
    // whole-batch retries (createItem-success / cursor-write-fail) without
    // producing duplicates. Returns 200 on this branch (vs 201 on create) so
    // the caller can distinguish the realized effect.
    //
    // Update semantics: properties / tier / occurred_at via `ItemStore.update`
    // (shallow-merge); tags via `metadata.set`; edges via `applyInlineEdges`
    // (replace-by-edge-type). Fields only meaningful at create time (id,
    // state, capture_*) are ignored — the existing row's id wins.
    if (stampedSource && body.source_id) {
      // Including trashed rows, deliberately. `findBySourceId` hides them,
      // which would send a re-sync of an item the user had deleted into
      // the create path, where `create`'s own dedup pre-check (which does
      // not filter state) finds the same row and refuses with a 409 that
      // never clears: the row stays trashed, so every later sync fails the
      // same way and the connector is wedged on one item.
      const existing = await storage.items.findBySourceIdIncludingTrashed(
        stampedSource,
        body.source_id,
      );
      // The declared-type match is checked on BOTH arms below rather than
      // once here, and the difference is disclosure. The row's type is a
      // gate rather than a filter: gate before disclosing, so a refusal
      // cannot be read off the body, and the match's refusal names
      // `item_id`, `declared_type` and `actual_type`. Answering it ahead
      // of `requireTypeAccess` would disclose the row's real type to a
      // caller the type gate is about to refuse and tell nothing.
      //
      // So each arm runs it last among its own gates. That is two call
      // sites for one rule, which is the shape this codebase treats as a
      // hazard: the trashed arm has its own named test for exactly that
      // reason, and deleting either call reddens one case and only one.
      if (existing?.state === "trashed") {
        // The user deleted this. Reviving it would overturn that decision
        // silently, and refusing it would fail the same sync on every retry
        // for as long as the row stays trashed, so the sync is acknowledged
        // and nothing is written or published.
        //
        // **What the acknowledgment may disclose, stated rather than left
        // to where this `return` sits.** The natural key bounds some axes
        // and not others, and only the ones it bounds are safe to answer on:
        //
        //  - The row itself is disclosed, because every part of reaching it
        //    is already the caller's own. `source` is the credential's own
        //    or one its key was given to write under, and cannot be chosen
        //    past those, and the `source_id` came from this request.
        //  - The extension namespaces are NOT, because that axis is not
        //    bounded by the natural key. `extension_permissions` are per
        //    credential, so a row can carry namespaces this caller holds
        //    nothing on — written by a person or by another tool. Hence the
        //    same filter the other eleven sites in this file use.
        //  - The type is NOT either, and that is a gate rather than a
        //    filter. A source outlives any one credential's type map, so a
        //    credential whose map has since narrowed, or another key
        //    claiming the same source, still resolves rows whose type it
        //    does not hold. The update branch below refuses
        //    those on the resolved row's type; refusing here too is what
        //    makes the two branches agree about who may address one row,
        //    instead of the answer depending on whether the user happened
        //    to have trashed it.
        //
        // Gate before disclosing, so a refusal cannot be read off the body,
        // and a key that may not read the row learns only that its key is
        // taken.
        requireResolvedRowWrite(c, existing);
        // A write never re-types the row it lands on, and an
        // acknowledgment is a write's answer, so a body naming another
        // type is refused here as the route's 409 description says.
        requireDeclaredTypeMatches(type, existing);
        return c.json(
          await acknowledgedItemBody(storage, requireAuth(c), existing),
          200,
        );
      }
      if (existing) {
        // Authorize the update against the row it lands on, not the body
        // that addressed it. Every gate above ran on `type`, which the
        // caller chose and which this branch never writes: the update
        // takes the resolved row's type as it stands, so a type the
        // credential holds write on must not admit an edit to a row of
        // another. These are the gates `PATCH /items/{id}` runs; running
        // them here is what makes the two doors agree. The create path
        // below keeps authorizing the claim, because there the claim is
        // the row. Refused without naming the row where the key may not
        // read it, so every envelope below, the conditional upsert's `409`
        // with its snapshot and id among them, reaches only a key that
        // may write the row it describes.
        requireResolvedRowWrite(c, existing);
        // No check on the row's own `source` here, and none is owed. The
        // lookup keyed on `stampedSource`, so the row carries a source
        // this credential may write under by construction: its own, or
        // one its key claims. A row another credential wrote under a
        // shared claim is exactly the row a second device must land on,
        // which is what the claim is for.

        // If the caller explicitly supplied `id` but it doesn't match the row
        // resolved by (source, source_id), reject rather than silently winning
        // with the existing row's id. A 200 response carrying a different id
        // than the body would be a confusing surprise; signaling the conflict
        // gives the caller a clear path to reconcile.
        if (body.id !== undefined && body.id !== existing.id) {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            "Request `id` does not match the item resolved by (source, source_id)",
            {
              field: "id",
              requested_id: body.id,
              existing_id: existing.id,
              source: stampedSource,
              source_id: body.source_id,
            },
          );
        }

        // And the same refusal on the type. `type` is required by this
        // route because the create branch needs it, but it plays no part
        // in resolving the row, so a body naming one type while the
        // natural key lands on another would otherwise be merged in
        // silently. Shared with the bulk door rather than written twice,
        // so the two doors cannot drift apart on it.
        requireDeclaredTypeMatches(type, existing);

        // Judged on the merged result rather than the body, mirroring the
        // merge the storage layer performs: a null on a required field is
        // kept for the type to refuse, and only the merged result shows it,
        // so a row that could not have been created in the state it sat in
        // would otherwise land with a 200 and no signal.
        if (
          body.properties !== undefined &&
          getTypeSchema(existing.type) !== undefined
        ) {
          const merged = mergeUpdateProperties(
            existing.properties,
            resolveIncomingProperties(existing.type, properties),
            // "merge", because this branch is the natural-key upsert on
            // `POST /items` and that route offers no mode. Stated rather
            // than defaulted silently, so the prediction is visibly tied to
            // what the door it predicts can actually be asked for.
            "merge",
          );
          const validation = validateProperties(existing.type, merged);
          if (!validation.success) {
            throw new MarfaError(
              ErrorCode.INVALID_PROPERTIES,
              "Invalid properties",
              { errors: validation.errors },
            );
          }
        }

        const upsertResult = await storage.runInTransaction(async () => {
          const updated = await storage.items.update(existing.id, {
            ...(body.properties !== undefined && { properties }),
            ...(tierValue !== undefined && { tier: tierValue }),
            ...(body.occurred_at !== undefined && {
              occurred_at: body.occurred_at,
            }),
            ...(body.version !== undefined && { version: body.version }),
          });
          if ("error" in updated) {
            // Reachable only when the caller sent a `version`, which is what
            // makes this upsert conditional. The envelope is the update
            // door's, because a caller that named a version is doing the
            // same thing here and should read the same answer.
            return { conflict: updated, item: null } as const;
          }

          if (Array.isArray(body.tags)) {
            await storage.metadata.set(updated.id, body.tags);
          }
          const edgeChanges = body.edges
            ? await applyInlineEdges(
                storage,
                updated.id,
                body.edges,
                (edgeType) => {
                  requireEdgePermission(c, edgeType, "write");
                },
                mayReadEdgeEnd(c),
              )
            : undefined;

          const meta = await storage.metadata.get(updated.id);
          return {
            conflict: null,
            item: updated,
            metadata: meta,
            edgeChanges,
          } as const;
        });

        if (upsertResult.item === null) {
          // Stamped here for the same reason the update door stamps it: the
          // refusal is returned rather than thrown, so the error handler
          // that normally sets the header never runs.
          c.header("X-Error-Code", upsertResult.conflict.error.code);
          return c.json(upsertResult.conflict, 409);
        }

        const {
          item: updatedItem,
          metadata: updatedMetadata,
          edgeChanges: updatedEdgeChanges,
        } = upsertResult;

        const hydratedExisting = await hydrateEdgesForItem(
          storage,
          requireAuth(c),
          updatedItem.id,
        );
        const itemWithEdges = { ...updatedItem, edges: hydratedExisting };

        await publish({
          type: "updated",
          item: updatedItem,
          metadata: updatedMetadata,
        });
        // After the item, and after the transaction that wrote both. A
        // single-item door always announces: a subscriber cannot tell an
        // edge written through an item from one written through
        // `/edges`, so silence here would make propagation depend on
        // which door the writer used.
        if (updatedEdgeChanges) {
          await announceInlineEdges(updatedEdgeChanges);
        }
        void storage.audit.log({
          client_ip: c.get("clientIp") ?? null,
          key_id: c.get("apiKey")?.id,
          action: "item.update",
          resource_type: "item",
          resource_id: updatedItem.id,
          details: {
            type: updatedItem.type,
            idempotent: true,
            source: stampedSource,
            source_id: body.source_id,
          },
        });
        return c.json(
          {
            item: itemWithEdges,
            metadata: filterMetadataForCaller(updatedMetadata, c.get("apiKey")),
          },
          200,
        );
      }
    }

    // A create arriving a second time under an id the caller minted.
    //
    // A synced client names a row before the server has seen it, so when
    // the response to its create is lost it retries with the same id.
    // The server already holds that row: the second arrival is the
    // client's own write, not a collision with somebody else's. Refusing
    // it forever is what strands the item — the client reads 409 as
    // transient, retries, and every later edit to that item queues behind
    // it. So the contract answers success and hands back the row.
    //
    // **Both a pre-check and a catch, and each covers what the other
    // cannot.** The pre-check answers a repeat without entering the write
    // path, whose refusals are about a write this caller is not making
    // again. The catch has to exist because the pre-check races: two sends
    // of one id can both find nothing, and the loser of the insert still
    // needs an answer other than 409.
    //
    // One comparison serves both, so the two paths cannot disagree about
    // what a repeat is or which gates it passes.
    const repeatedRow = async (): Promise<Item | null> => {
      // Only a caller-minted id can be a repeat. A server-generated one
      // colliding is not this caller's own write and has no business
      // being answered with somebody's row.
      const clientId = body.id;
      if (clientId === undefined) return null;
      // Including trashed, for the reason the natural-key branch is: a
      // row the user has since deleted would otherwise refuse this retry
      // forever, and the retry is not asking to revive it. The row comes
      // back in whatever state it holds.
      const existing = await storage.items.getIncludingTrashed(clientId);
      // A row this caller cannot read goes on to the insert's plain
      // `conflict`, which says the id is taken and nothing of the row.
      if (!existing || !mayReadRow(c, existing)) return null;

      // **No type gate of its own here, and its absence is the honest
      // shape.** The comparison below is exact, so a row that is
      // acknowledged has the type the body named — and that type already
      // cleared `requireTypeAccess` at the top of this route. A second
      // call could therefore never refuse, and a gate that cannot refuse
      // reads as a protection somebody is relying on.
      //
      // The natural-key arms do carry one, and the difference is real:
      // they resolve by `(source, source_id)`, which says nothing about
      // the row's type, so the row can be a type the caller may not
      // write.
      //
      // **`id_reused` here, where the natural-key branch above says
      // `type_mismatch`, and the difference is which thing is in
      // question.** There the caller resolved a row by its `(source,
      // source_id)` and declared a type the row is not: the id was never
      // named and the declaration is the mistake. Here the caller minted
      // the id, and the id is taken by a row it is not describing —
      // the same mistake the edge door answers for an id naming a
      // different triple, so the same code, with `details.differs`
      // naming what disagrees.
      if (existing.type !== type) {
        throw new MarfaError(
          ErrorCode.ID_REUSED,
          `Item id ${existing.id} already names an item of type "${existing.type}", not "${type}"`,
          {
            existing_id: existing.id,
            differs: ["type"],
            declared_type: type,
            actual_type: existing.type,
          },
        );
      }
      return existing;
    };

    /** Whether this error is the trap firing on the id this request sent. */
    const isOwnIdCollision = (err: unknown): boolean =>
      body.id !== undefined &&
      err instanceof MarfaError &&
      err.code === ErrorCode.CONFLICT &&
      // `existing_id` is set by the store from the colliding row, so this
      // equality cannot pick up a CONFLICT raised elsewhere in the
      // transaction.
      (err.details as { existing_id?: string } | undefined)?.existing_id ===
        body.id;

    const alreadyHeld = await repeatedRow();
    if (alreadyHeld) {
      return c.json(
        await acknowledgedItemBody(storage, requireAuth(c), alreadyHeld),
        200,
      );
    }

    let writeResult;
    try {
      writeResult = await storage.runInTransaction(async () => {
        const created = await storage.items.create({
          type,
          properties,
          id: body.id,
          state: body.state as ItemState | undefined,
          tier: tierValue,
          occurred_at: body.occurred_at,
          source: stampedSource,
          source_id: body.source_id,
          capture_latitude: body.capture_latitude,
          capture_longitude: body.capture_longitude,
          tags: body.tags,
        });

        // Atomic edges: for each entry, this item is the source; listed ids
        // are targets. assertEdgesCanBeCreated enforces cardinality / type
        // constraints / cycle rules across the whole batch in grouped queries;
        // failure rolls the entire transaction. The created rows are kept:
        // they are the complete outbound-edge set of an item born this
        // instant, so the response hydration below needs no read.
        const createdEdges: Edge[] = [];
        if (body.edges) {
          const proposals = Object.entries(body.edges).flatMap(
            ([edgeType, targets]) =>
              targets.map((targetId) => ({
                source_id: created.id,
                target_id: targetId,
                edge_type: edgeType,
              })),
          );
          if (proposals.length > 0) {
            await assertEdgesCanBeCreated(
              storage.edges,
              storage.items,
              proposals,
              mayReadEdgeEnd(c),
            );
            for (const p of proposals) {
              createdEdges.push(
                await storage.edges.createRaw({
                  source_id: p.source_id,
                  target_id: p.target_id,
                  edge_type: p.edge_type,
                }),
              );
            }
          }
        }

        // A fresh create's metadata layer is exactly what the create wrote:
        // its tags (stored verbatim, `input.tags ?? []`) over empty
        // extensions. Reading it back re-fetched the row written one
        // statement earlier in this same transaction.
        return {
          item: created,
          metadata: {
            item_id: created.id,
            tags: body.tags ?? [],
            extensions: {},
          },
          createdEdges,
        };
      });
    } catch (err) {
      // The concurrency backstop. The row appeared between the pre-check
      // and the insert, which is the one case the pre-check cannot cover.
      if (!isOwnIdCollision(err)) throw err;
      const raced = await repeatedRow();
      if (!raced) throw err;
      return c.json(
        await acknowledgedItemBody(storage, requireAuth(c), raced),
        200,
      );
    }
    const { item, metadata, createdEdges } = writeResult;

    // Sorted to the listing's read order (created_at DESC, id DESC) before
    // grouping, because the block is cut at the cap and its cursor is read
    // by that listing: body order fed in raw would carry the oldest fifty
    // of a large batch with a cursor that re-fetches them and never
    // reaches the newest.
    const orderedEdges = [...createdEdges].sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    );
    const itemWithEdges = {
      ...item,
      edges: groupAndCap(
        orderedEdges,
        HYDRATE_PER_TYPE_CAP,
        ITEM_EDGES_CURSOR_KEY,
      ),
    };

    await publish({
      type: "created",
      item,
      metadata,
    });
    // The item's own edges, announced after the item itself so a
    // subscriber that resolves an edge's endpoints has already been told
    // the new one exists.
    for (const edge of createdEdges) {
      await publishEdge({ type: "edge_created", edge });
    }
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.create",
      resource_type: "item",
      resource_id: item.id,
      details: { type: item.type },
    });
    return c.json(
      {
        item: itemWithEdges,
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
      },
      201,
    );
  });

  router.openapi(getItemStatsRoute, async (c) => {
    requireAuth(c);
    const callerKey = c.get("apiKey");
    const { by } = c.req.valid("query");
    const typeFilter = getTypeFilter(c);
    // These counts summarize the listing, so they narrow with it.
    const instanceConfig = await readInstanceConfig(storage.settings);
    const enforcement = resolveEnforcement(instanceConfig, callerKey);
    const stats = await storage.items.stats(
      typeFilter,
      enforcement.source_filter,
      by,
    );
    return c.json(stats, 200);
  });

  router.openapi(listItemsRoute, async (c) => {
    requireAuth(c);

    // Before anything reads the validated query, because validation has
    // already dropped an undeclared key by then and a dropped time filter
    // is indistinguishable from one that was never sent. The edge
    // shorthands are allowed by pattern: the type is part of the key, so
    // no schema can enumerate them.
    refuseUnknownQueryParams(c.req.raw.url, listItemsRoute.request.query, {
      allow: [EDGE_SHORTHAND_KEY],
    });

    const query = c.req.valid("query");

    // `updated_after` implies `(updated_at, id)` ascending — it is the
    // only order a catch-up cursor can advance through. A request that
    // also names a different sort is contradicting itself, and honoring
    // one half silently is the same failure as ignoring a renamed
    // parameter: the caller gets a page that looks right and cannot be
    // resumed. Refuse instead of picking a winner.
    if (query.updated_after !== undefined) {
      const conflicting =
        (query.sort !== undefined && query.sort !== "updated_at") ||
        (query.direction !== undefined && query.direction !== "asc");
      if (conflicting) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          "updated_after orders by (updated_at, id) ascending and cannot be combined with a different sort or direction. Drop sort/direction, or drop updated_after.",
        );
      }
    }

    const type = query.type;
    // Grammar, the global wildcard and an unknown concrete type, decided once
    // for every list surface; the reasoning is at `assertTypeFilter`.
    assertTypeFilter(type);

    // `any` is a widening, not a state, so it never reaches the column
    // comparison. Shared with `GET /export`, which reads the same filter.
    const { state, all_states: allStates } = resolveStateFilter(query.state);

    const tagsParam = query.tags;
    const tags = tagsParam
      ? tagsParam.split(",").map((t) => t.trim())
      : undefined;

    // ?edge[X]=Y and ?backref[X]=Y shorthands are AND-composed with any existing filter= param.
    const rawQuery = new URL(c.req.raw.url).searchParams;
    const edgeClauses: string[] = [];
    const shorthandRe = EDGE_SHORTHAND_KEY;
    for (const [key, val] of rawQuery.entries()) {
      if (!shorthandRe.test(key)) continue;
      // A shorthand with nothing after the `=`, skipped, would return an
      // unfiltered page at 200: the failure the unknown-parameter refusal
      // exists to remove, reached through the exemption that keeps the
      // shorthand working. The exemption matches
      // on the key alone, because the type is part of the key; the value
      // has to be checked where it is read. `updated_after` carries
      // `.min(1)` for the same reason on this same door.
      if (val === "") {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `The "${key}" filter was sent with no value. An edge shorthand names the item on the other end of the edge, so an empty one narrows nothing and would return the whole listing.`,
          { empty_parameters: [key] },
        );
      }
      edgeClauses.push(`${key} eq "${val.replace(/"/g, '\\"')}"`);
    }
    let filter = query.filter ?? undefined;
    if (edgeClauses.length > 0) {
      filter = filter
        ? `${filter} AND ${edgeClauses.join(" AND ")}`
        : edgeClauses.join(" AND ");
    }
    // The shorthand and the full form are one expression by this point,
    // so one pass over it covers both. `GET /search` makes the same call.
    assertFilterEdgeTermsReadable(c, filter);
    // Read tier from the raw query string — zod-openapi occasionally drops enum strings.
    const rawTier = c.req.query("tier");
    const tier: "library" | "feed" | undefined =
      rawTier === "library"
        ? "library"
        : rawTier === "feed"
          ? "feed"
          : undefined;
    const includeSet = new Set(
      (query.include ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    const includeMetadata = includeSet.has("metadata");
    const includeEdges = includeSet.has("edges");
    const includeExtensions = includeSet.has("extensions");

    // system.* is excluded by default and opted back in by the token or by a
    // type filter that names the namespace. Through the shared rule rather
    // than restated here, so no door matches rows its siblings hide.
    const excludeSystemTypes = excludesSystemTypes(includeSet, type);

    const callerKeyForRead = c.get("apiKey");
    const instanceConfigForRead = await readInstanceConfig(storage.settings);
    const enforcementForRead = resolveEnforcement(
      instanceConfigForRead,
      callerKeyForRead,
    );
    const typeFilterForList = getTypeFilter(c);
    const result = await storage.items.list({
      type,
      state,
      source: query.source,
      // The lever is decided per row from the row's own type, not from the
      // `?type=` parameter: a bare listing, an ancestor wildcard, a tier
      // filter and a state filter all reach a covered row without naming it,
      // so keying off the request made a read-narrowing control optional.
      source_filter: enforcementForRead.source_filter,
      tier,
      exclude_system_types: excludeSystemTypes,
      tags,
      filter,
      readable_sources: typeFilterForList,
      allowed_types: typeFilterForList.allowed,
      excluded_types: typeFilterForList.excluded,
      // The query schema's regex already constrains this to a system column or
      // `properties.<field>`; the storage layer re-validates via parseSortField.
      sort: (query.sort as ItemSortField | undefined) ?? undefined,
      direction: query.direction ?? undefined,
      occurred_after: query.occurred_after,
      occurred_before: query.occurred_before,
      updated_after: query.updated_after,
      updated_before: query.updated_before,
      all_states: allStates,
      limit: query.limit,
      cursor: query.cursor,
    });
    const rows = await withCascadeMarks(storage, requireAuth(c), result.data);

    const ids = rows.map((item) => item.id);
    const apiKey = c.get("apiKey");
    const edgesMap = includeEdges
      ? await hydrateEdgesForItems(storage, requireAuth(c), ids)
      : null;
    const extensionsMap = includeExtensions
      ? await hydrateExtensionsForItems(storage, ids, apiKey)
      : null;
    const decorate = (item: (typeof rows)[number]) => {
      const withEdges = edgesMap
        ? { ...item, edges: edgesMap.get(item.id) ?? {} }
        : item;
      return extensionsMap
        ? { ...withEdges, extensions: extensionsMap.get(item.id) ?? {} }
        : withEdges;
    };

    if (includeMetadata) {
      const metadataList = await storage.metadata.getMany(ids);
      const metadataMap = new Map(metadataList.map((m) => [m.item_id, m]));
      const apiKey = c.get("apiKey");
      return c.json(
        {
          data: rows.map((item) => ({
            item: decorate(item),
            metadata: filterMetadataForCaller(
              metadataMap.get(item.id) ?? {
                item_id: item.id,
                tags: [],
                extensions: {},
              },
              apiKey,
            ),
          })),
          next_cursor: result.next_cursor,
        },
        200,
      );
    }

    return c.json(
      {
        data: rows.map(decorate),
        next_cursor: result.next_cursor,
      },
      200,
    );
  });

  router.openapi(getItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const item = requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    // Non-optional, which `c.get("apiKey")` is not: the edge blocks
    // below are narrowed against it, and the gate above has already
    // refused a request carrying none.
    const callerKey = requireAuth(c);

    const includeSet = new Set(
      (c.req.query("include") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    const includeBackrefs = includeSet.has("backrefs");
    const includeNeighbors = includeSet.has("neighbors");
    const includeVersions = includeSet.has("versions");

    // The base shape — item (with outbound edges) + metadata — is unconditional;
    // it's what every existing caller already depends on. The three include
    // blocks are additive and default-off so the lean read stays lean.
    const [metadata, edges, backrefs, versions] = await Promise.all([
      storage.metadata.get(id),
      hydrateEdgesForItem(storage, callerKey, id),
      includeBackrefs
        ? hydrateBackrefsForItem(storage, callerKey, id)
        : Promise.resolve(null),
      includeVersions ? storage.versions.list(id) : Promise.resolve(null),
    ]);

    let neighbors: { item: Item; metadata: Metadata }[] | undefined;
    // True when the 1-hop neighbor set was capped (more neighbors exist than
    // were hydrated). Distinct from the per-type edge block's `next_cursor`: several
    // edge types can each sit below their per-type cap while their COMBINED
    // neighbor set exceeds the bound, so this is the only signal that catches
    // that case. Consumers must treat every neighbor-derived view as
    // incomplete when this is set and page the per-type edge/backref endpoints.
    let neighborsTruncated = false;
    // How many neighbors the caller may not read, counted over the edge
    // blocks this response carries. A neighbor outside the caller's scope
    // is omitted, never leaked, and the count says so: without it a partial
    // neighborhood reads as a complete one, and a caller missing a type
    // scope renders an item with none of its relations as though it had
    // none.
    //
    // **It counts what the item map hid, and cannot count what the edge
    // map hid.** A relationship the credential may not read is not in
    // those blocks at all, so its far end never becomes a neighbor to
    // omit. Counting it would say how many relationships of a kind this
    // item has, which is the fact the edge gate withholds — the same
    // decision that makes `GET /edges` drop a row rather than refuse the
    // page. So an app missing an *edge* scope still sees a neighborhood
    // that looks complete, and the signal it has to read instead is the
    // block: a kind of relationship it holds no scope on has no block
    // here, whatever the item carries.
    let neighborsOmitted = 0;
    if (includeNeighbors) {
      // The 1-hop neighborhood: the far-end items of the edge blocks present
      // in this response — outbound targets always, inbound sources when
      // `backrefs` was also requested. Each neighbor is re-authorized through
      // the same per-type read gate the bulk-get path uses, so a
      // neighbor the caller cannot read is silently omitted, never leaked.
      const neighborIds = new Set<string>();
      for (const block of Object.values(edges)) {
        for (const e of block.data) neighborIds.add(e.target_id);
      }
      if (backrefs) {
        for (const block of Object.values(backrefs)) {
          for (const e of block.data) neighborIds.add(e.source_id);
        }
      }
      neighborIds.delete(id);

      // Bound the hydration so a pathological fan-out can't pin the worker. When
      // the bound bites, `neighbors_truncated` flags it — the per-block
      // `next_cursor` does NOT cover this, since the cap is on the combined set
      // across types, not any single type.
      neighborsTruncated = neighborIds.size > MAX_NEIGHBOR_IDS;
      const ids = [...neighborIds].slice(0, MAX_NEIGHBOR_IDS);
      if (ids.length === 0) {
        neighbors = [];
      } else {
        const found = await storage.items.getMany(ids);
        const visible: Item[] = [];
        // Kept apart because they mean different things to whoever reads the
        // log: a type the credential lacks is a scope to widen, an edge whose
        // far end is gone is a repair.
        const unreadableTypes = new Set<string>();
        let unresolved = 0;
        for (const nid of ids) {
          const neighbor = found.get(nid);
          if (!neighbor) {
            unresolved += 1;
            continue;
          }
          // The reserved namespace is not the caller's business and its
          // absence is not a permission answer, so it is not counted.
          if (neighbor.type.startsWith("system.")) continue;
          try {
            checkTypeAccess(apiKey, neighbor.type, "read");
          } catch {
            unreadableTypes.add(neighbor.type);
            neighborsOmitted += 1;
            continue;
          }
          visible.push(neighbor);
        }
        if (neighborsOmitted > 0 || unresolved > 0) {
          log("warn", "neighbors omitted from item read", {
            item_id: id,
            key_id: apiKey?.id,
            omitted_unreadable: neighborsOmitted,
            omitted_unresolved: unresolved,
            unreadable_types: [...unreadableTypes],
          });
        }
        const metaList = await storage.metadata.getMany(
          visible.map((n) => n.id),
        );
        const metaById = new Map(metaList.map((m) => [m.item_id, m]));
        neighbors = visible.map((n) => ({
          item: n,
          metadata: filterMetadataForCaller(
            metaById.get(n.id) ?? { item_id: n.id, tags: [], extensions: {} },
            apiKey,
          ),
        }));
      }
    }

    return c.json(
      {
        item: { ...item, edges },
        metadata: filterMetadataForCaller(metadata, apiKey),
        ...(includeBackrefs && backrefs ? { backrefs } : {}),
        ...(neighbors !== undefined
          ? {
              neighbors,
              neighbors_truncated: neighborsTruncated,
              neighbors_omitted: neighborsOmitted,
            }
          : {}),
        ...(includeVersions && versions
          ? { versions: { data: versions, next_cursor: null } }
          : {}),
      },
      200,
    );
  });

  router.openapi(updateItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const { conflict: conflictMode } = c.req.valid("query");
    // The same header the replay cache in front of this route claims. Read
    // here so a keep-both sibling can be given an id derived from it, which
    // is what makes a re-executed write produce one sibling rather than two.
    const idempotencyKey = c.req.header("Idempotency-Key") ?? null;
    const hasProperties =
      body.properties !== undefined && typeof body.properties === "object";
    const hasEdges =
      body.edges !== undefined &&
      typeof body.edges === "object" &&
      Object.keys(body.edges).length > 0;
    const hasTier = body.tier !== undefined;
    const hasOccurredAt = body.occurred_at !== undefined;
    const hasSourceId = body.source_id !== undefined;

    if (
      !hasProperties &&
      !hasEdges &&
      !hasTier &&
      !hasOccurredAt &&
      !hasSourceId &&
      body.retype !== true
    ) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "At least one of `properties`, `edges`, `tier`, `occurred_at`, `source_id`, or `retype` is required.",
      );
    }
    if (body.occurred_at !== undefined && !isValidTimestamp(body.occurred_at)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "occurred_at must be an ISO 8601 string",
      );
    }
    const item = requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    requireTypeAccess(c, item.type, "write");

    // Held to the same rule as every other door rather than refused
    // outright: a claim that matches the row is the ordinary case and
    // passes, a claim that disagrees is the re-type this route does not
    // perform. Refusing any `type` at all would have been tidier to
    // describe and would have failed most reactive syncs in the fleet on
    // their first request.
    if (body.retype === true && body.type === undefined) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "`retype` needs the `type` to move the item to",
      );
    }
    // Captured rather than re-derived, so the narrowing survives: a
    // boolean does not tell the compiler that `body.type` is a string at
    // the three sites below that need it to be one. A move to the type
    // the row already has is not a move: a corpus re-type sends `retype`
    // to rows already at the destination, and those take no version step.
    const retypeTo =
      body.retype === true && body.type !== item.type ? body.type : undefined;
    const retyping = retypeTo !== undefined;
    if (retyping) {
      // Write on the type being left is already required above; this is
      // write on the one being entered. A caller may not move a row into
      // a type it could not have created the row under.
      requireTypeAccess(c, retypeTo, "write");
    } else if (body.type !== undefined) {
      requireDeclaredTypeMatches(body.type, item);
    }

    // Same rule the create door applies, judged on the resolved row's
    // type. The claim above is held to that type rather than replacing
    // it: nothing below reads a caller-supplied type.
    assertTierApplicable(item.type, body.tier);

    // Natural-key uniqueness check. The `(source, source_id)` tuple is
    // unique — the same constraint enforced at create time.
    // Reject before the write so no partial state lands. PATCHing the value
    // the item already carries is a no-op success. Cross-source isolation is
    // automatic: `findBySourceId` scopes by `item.source`, so the same
    // source_id literal under a different `source` never collides.
    if (
      hasSourceId &&
      body.source_id !== undefined &&
      body.source_id !== item.source_id
    ) {
      const newSourceId = body.source_id;
      const existing = await storage.items.findBySourceId(
        item.source,
        newSourceId,
      );
      if (existing && existing.id !== id) {
        throw new MarfaError(
          ErrorCode.SOURCE_ID_CONFLICT,
          `source_id "${newSourceId}" is already in use under source "${item.source}"`,
          { source: item.source, source_id: newSourceId },
        );
      }
    }

    // Shape-validate and permission-gate the edges payload up-front.
    //
    // **Not redundant with `applyInlineEdges`, and not because it
    // refuses earlier — the helper's permission gate and its id and
    // self-edge refusals all run before its deletes, so nothing here
    // saves a rollback.** Two things only this pass does: it is the only
    // check that the value at an edge type is an array at all, which the
    // helper assumes, and its refusals carry this door's own messages
    // (`edges.<type> must be an array of item ids`), which callers read.
    // Delete it and a non-array value reaches a `for` over a non-iterable
    // instead of a 400.
    if (hasEdges && body.edges) {
      for (const [edgeType, targets] of Object.entries(body.edges)) {
        if (!Array.isArray(targets)) {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `edges.${edgeType} must be an array of item ids`,
          );
        }
        for (const target of targets) {
          if (!isValidId(target)) {
            throw new MarfaError(
              ErrorCode.INVALID_ID,
              `Invalid target id in edges.${edgeType}`,
            );
          }
        }
        requireEdgePermission(c, edgeType, "write");
      }
    }

    if (body.properties || retyping) {
      // The levers this door has to ask before it writes. Read here
      // rather than at the top of the handler because this is the only
      // branch that needs them: a body carrying no `properties` and no
      // move changes nothing a schema has an opinion about. A move alone
      // does: the row's properties have to satisfy the type it enters.
      const enforcementForUpdate = resolveEnforcement(
        await readInstanceConfig(storage.settings),
        c.get("apiKey"),
      );
      // The type the row ends up as, which is what the resulting
      // properties have to satisfy. Validating against the type being left
      // would admit a move whose result the destination calls invalid,
      // which is the whole hazard of moving a corpus.
      const resultingType = retypeTo ?? item.type;
      // The strict-mode lever, which this door went past. `POST /items`
      // asks it of the properties the caller sent, and so does the
      // restore door; asked of the same input here, through the same
      // function, so the three cannot drift. A caller could otherwise
      // write a property no type declares through the update door that
      // the create door beside it refuses, on a type the lever names —
      // and the property reads back ever after undeclared and unmarked
      // under the type's current version.
      //
      // Against the payload rather than the merged result, because that
      // is the reading the other two callers take: the lever refuses a
      // caller introducing an undeclared property, and measuring the
      // merge would instead freeze every row that already carries one
      // from before the lever was set.
      //
      // Against the type the row ends up as, for the reason the
      // validation below uses it: a move is judged by the destination.
      const undeclared =
        body.properties === undefined
          ? undefined
          : undeclaredPropertyRefusal(
              enforcementForUpdate,
              resultingType,
              body.properties,
            );
      if (undeclared) throw undeclared;
      // The verdict on the row's resulting properties belongs to whoever
      // computes them. At the current version that is this door, through
      // the shared helper rather than a shallow spread of its own: a copy
      // that validated the merged set while the store wrote the replaced
      // one would pass a write dropping a required field on the strength
      // of the value it was removing. At a stale version the store merges
      // against the ancestor and judges that result before it writes; the
      // body laid over the current row is not what lands, and judging it
      // would refuse a write whose merge keeps a field the other writer
      // added since.
      if (body.version === item.version) {
        const merged = mergeUpdateProperties(
          item.properties,
          resolveIncomingProperties(resultingType, body.properties),
          body.properties_mode ?? "merge",
        );
        if (getTypeSchema(resultingType)) {
          const validation = validateProperties(resultingType, merged);
          if (!validation.success) {
            throw new MarfaError(
              ErrorCode.INVALID_PROPERTIES,
              "Invalid properties",
              {
                errors: validation.errors,
              },
            );
          }
        }
      }
    }

    // Before the version check inside the transaction, so a stale write
    // cannot tell a target the key may not read from a missing one.
    if (hasEdges && body.edges) {
      const mayReadTarget = mayReadEdgeEnd(c);
      for (const [edgeType, targets] of Object.entries(body.edges)) {
        const schema = getEdgeTypeSchema(edgeType);
        if (!schema) {
          throw new MarfaError(
            ErrorCode.EDGE_TYPE_NOT_FOUND,
            `Unknown edge type: ${edgeType}`,
          );
        }
        // Detect duplicate target ids in the payload (same edge would
        // fail existsExact after the first insert).
        const uniqueTargets = new Set<string>();
        for (const target of targets) {
          if (uniqueTargets.has(target)) {
            throw new MarfaError(
              ErrorCode.EDGE_CONSTRAINT_VIOLATION,
              `Duplicate target ${target} in edges.${edgeType}`,
            );
          }
          uniqueTargets.add(target);
          const targetItem = await storage.items.get(target);
          if (!targetItem || !mayReadTarget(targetItem.type)) {
            throw edgeTargetNotFound(target);
          }
        }
      }
    }

    // Declared outside the transaction so the announcement can happen
    // after it commits. `undefined` when the request carried no edges.
    let patchedEdgeChanges: InlineEdgeChanges | undefined;
    const txResult = await storage.runInTransaction(async () => {
      // The version is enforced here for the one arm that never reaches the
      // store: a write carrying only `edges`, or a `retype` naming the type
      // the row already has, applies over whatever the row has become, so
      // without this the door would collect a required precondition and
      // discard it — worse than not asking at all, because a caller reads
      // a refusal that never came as proof it was current.
      //
      // Inside the transaction and re-reading the row, not against the copy
      // read before it: a check outside is advisory, and any write landing
      // in the window between the two is exactly what the precondition
      // exists to notice.
      //
      // The envelope minus its merge half, rather than a bare refusal.
      // Nothing here can be merged — that needs two property sets and the
      // fields that collide, and a request carrying no properties has
      // neither — so there is no `ancestor`, no `conflicting_fields` and no
      // `merge_policy`. But `error.status` and `current` are on every
      // single-write refusal carrying this code, so a client reading
      // `body.current.version` reads it here too instead of finding
      // `undefined` on one door out of three. (The bulk doors report the
      // code per entry inside their own envelope and are not in that set.)
      if (
        !hasProperties &&
        !hasTier &&
        !hasOccurredAt &&
        !hasSourceId &&
        !retyping
      ) {
        const current = await storage.items.get(id);
        if (current && body.version !== current.version) {
          return staleVersion(
            current.version,
            current.properties,
            body.version,
            {
              id: current.id,
              tier: current.tier ?? "library",
              occurred_at: current.occurred_at,
              source_id: current.source_id ?? null,
              type: current.type,
            },
          );
        }
      }

      // Annotated rather than inferred: the `: item` arm is a plain `Item`,
      // and left to inference the union collapses to it — losing the
      // resolution report the store attaches on the other arm.
      const updated:
        ResolvedItem | ConflictResponse | AncestorUnavailableResponse =
        hasProperties || hasTier || hasOccurredAt || hasSourceId || retyping
          ? await storage.items.update(id, {
              properties: body.properties,
              ...(body.properties_mode !== undefined && {
                properties_mode: body.properties_mode,
              }),
              ...(retypeTo !== undefined && { type: retypeTo }),
              version: body.version,
              // Who resolves a collision, and the key that makes a retry
              // recognizable as one. Both are request-level facts rather
              // than fields of the item, which is why they ride here
              // rather than in the body.
              ...(conflictMode !== undefined && {
                conflict_mode: conflictMode,
              }),
              ...(idempotencyKey !== null && {
                idempotency_key: idempotencyKey,
              }),
              may_copy_edge: (
                edgeType: string,
                sourceType: string,
                targetType: string,
              ) =>
                mayWriteEdge(requireAuth(c), edgeType, sourceType, targetType),
              tier: hasTier ? body.tier : undefined,
              occurred_at: hasOccurredAt ? body.occurred_at : undefined,
              source_id: hasSourceId ? body.source_id : undefined,
            })
          : item;
      if (
        (hasProperties ||
          hasTier ||
          hasOccurredAt ||
          hasSourceId ||
          retyping) &&
        "error" in updated
      ) {
        return updated;
      }

      // Through the shared helper rather than a second copy of it: what a
      // second copy costs is every change after, made in one place and
      // missed in the other.
      if (hasEdges && body.edges) {
        patchedEdgeChanges = await applyInlineEdges(
          storage,
          id,
          body.edges,
          // Already gated up-front, before any write. Passed again
          // because the helper requires an answer rather than a default,
          // and re-running an idempotent check costs nothing.
          (edgeType) => {
            requireEdgePermission(c, edgeType, "write");
          },
          mayReadEdgeEnd(c),
        );
      }

      return updated;
    });

    if ("error" in txResult) {
      // Stamped here because this refusal is returned rather than thrown, so
      // the error handler that normally sets it never runs. Without it the
      // fresh answer and its idempotent replay describe one conflict
      // differently: the replay reads the code out of the recorded body and
      // sets the header, so a client that branches on it sees the header
      // appear only on the retry.
      c.header("X-Error-Code", txResult.error.code);
      return c.json(txResult, 409);
    }

    // Off the item before anything reads it. It describes what this write
    // did, not what the row is, and the row has no such column — leaving it
    // on would put a field in the published event, and in the response's
    // `item`, that no read of the item ever returns.
    const {
      conflict_resolution: resolution,
      conflict_sibling: sibling,
      conflict_sibling_edges: siblingEdges,
      ...resolvedItem
    } = txResult;

    const metadata = await storage.metadata.get(id);
    // The sibling first, then the row that gave its value up. A subscriber
    // then never observes a window in which the losing edit has left the
    // original and does not yet exist anywhere — which is the state this
    // whole feature exists to prevent.
    if (sibling) {
      await publish({
        type: "created",
        item: sibling,
        metadata: await storage.metadata.get(sibling.id),
      });
      await announceInlineEdges({ created: siblingEdges ?? [], deleted: [] });
    }
    await publish({
      type: "updated",
      item: resolvedItem,
      metadata,
    });
    // After the item, and after the transaction committed. Announcing
    // from inside would describe edges a rollback then took away.
    if (patchedEdgeChanges) {
      await announceInlineEdges(patchedEdgeChanges);
    }
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.update",
      resource_type: "item",
      resource_id: id,
    });
    const hydrated = await hydrateEdgesForItem(storage, requireAuth(c), id);
    return c.json(
      {
        item: { ...resolvedItem, edges: hydrated },
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
        // Present only where the server actually resolved a collision. It is
        // the only thing that names the sibling: no route reports what a
        // write created, so without this the row exists and nothing can
        // reach it.
        ...(resolution !== undefined && { conflict_resolution: resolution }),
      },
      200,
    );
  });

  router.openapi(deleteItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const key = requireAuth(c);

    const targetItem = requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    requireTypeAccess(c, targetItem.type, "write");
    const root = { id, type: targetItem.type };
    // **No live-connection refusal on the named row, because the cascade
    // below already covers it.** `planCascadeDelete` walks post-order and
    // pushes the root itself, so `toDelete` always contains the row named in
    // the URL and the loop inside the transaction asks the refusal of it like
    // any other. A second call here would be a duplicate rather than a defense.
    //
    // The check itself stays where the cascade is, and has to: the type gate
    // above ran against the named row alone, and a `parent-of` edge can carry
    // a live `system.connection` out through a delete of something else
    // entirely, when a grant's tokens must not outlive the row that names
    // their owner (`_connection-refusal.ts`).
    const snapshots = await storage.runInTransaction(async () => {
      const toDelete = await planCascadeDelete(storage.edges, id).catch(
        async (err: unknown) => {
          throw await withoutHiddenBlockers(storage, key, err);
        },
      );
      const snaps = await Promise.all(
        toDelete.map((delId) => storage.items.get(delId)),
      );
      // **Every row the cascade reaches, not just the one named in the URL.**
      // `parent-of` ships with `cascade_on_delete: "cascade"` and admits any
      // type at either end, so a connection that deletes a row it wrote takes
      // every child with it — including rows a live sibling wrote. Guarding
      // the target alone would leave the rule one edge away from being
      // void: the direct delete of a sibling's row refused while the same
      // row goes through the cascade.
      //
      // Inside the transaction so a refusal rolls the whole plan back rather
      // than leaving a partial cascade, and against the snapshots already
      // read rather than a second round of reads.
      // A `parent-of` edge from any row to a live grant would otherwise
      // carry the grant out through the cascade with no refusal, from a
      // credential that could not write it directly.
      for (const snap of snaps) {
        if (!snap) continue;
        refuseUnlessUninstalled(snap, mayReadType(key, snap.type));
      }
      for (const delId of toDelete) {
        await storage.items.delete(delId, delId === id ? undefined : root);
      }
      return snaps;
    });

    // Publish post-commit — a rollback must never leak a `deleted` event.
    for (const snapshot of snapshots) {
      if (snapshot) {
        // A bounded lifecycle soft-deletes to `revoked`.
        const state = softDeleteState(snapshot.type);
        await publish({
          type: "deleted",
          item: { ...snapshot, state },
          // The mark `storage.items.delete` records, on the same terms.
          ...(snapshot.id !== id &&
            state === "trashed" && { trashedWith: root }),
        });
      }
    }
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.delete",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  // Lifecycle (restore, transition) and versions live in sibling files.
  // Mounted at this point because the document emits paths in mount order,
  // and the generated document is checked in and held to the server.
  router.route("/", itemsLifecycleRoutes(storage));
  router.route("/", itemsVersionsRoutes(storage));

  // --- Metadata sub-routes ---

  // GET /items/:id/metadata
  router.openapi(getMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    const metadata = await storage.metadata.get(id);
    return c.json(
      { metadata: filterMetadataForCaller(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(putMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.

    const body = c.req.valid("json");
    const tags = body.tags;

    if (tags.length > MAX_TAGS_PER_ITEM) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
      );
    }

    const metadata = await storage.metadata.set(id, tags);
    await publish({
      type: "metadata_changed",
      item: await itemAfterMetadataWrite(storage, item),
      metadata,
    });
    return c.json(
      { metadata: filterMetadataForCaller(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(patchMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.

    const body = c.req.valid("json");
    const tags = body.tags;

    // Not subsumed by the projection below, though it reads as though it
    // should be: the projection counts a deduplicated set, so a body of 101
    // copies of one tag projects to one and passes it. This bounds what a
    // caller may send, that one bounds what the item may hold, and they are
    // different questions with different messages.
    if (Array.isArray(tags) && tags.length > MAX_TAGS_PER_ITEM) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
      );
    }

    // No projection here. Reading the metadata row, unioning the incoming
    // tags into it and refusing over the bound would read in one
    // transaction and write in another, so it would bound nothing under
    // concurrency, and it would cost an unconditional read on every
    // successful request to duplicate a refusal the store makes inside
    // the transaction that computes the set, with the same status, code
    // and message, so nothing on the wire could tell the two apart.
    //
    // What is still checked above is what a caller may *send*, which is a
    // different question and one the store cannot answer: a body of a
    // hundred and one copies of one tag projects to one and is inside the
    // bound.

    const metadata = await storage.metadata.merge(id, tags);

    await publish({
      type: "metadata_changed",
      item: await itemAfterMetadataWrite(storage, item),
      metadata,
    });
    return c.json(
      { metadata: filterMetadataForCaller(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(addTagsRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.

    const body = c.req.valid("json");
    const tags = body.tags;

    // The resulting set is bounded by the store, inside the transaction that
    // computes it. See the sibling door above for why there is no
    // projection here.
    const metadata = await storage.metadata.addTags(id, tags);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.tag",
      resource_type: "item",
      resource_id: id,
      details: { tags },
    });
    await publish({
      type: "metadata_changed",
      item: await itemAfterMetadataWrite(storage, item),
      metadata,
    });
    return c.json(
      { metadata: filterMetadataForCaller(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(purgeItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    requirePermission(c, "items.purge");
    // Including trashed, because purge follows trash; the message is the one
    // `storage.items.purge` answers, so a hidden row and no row read alike.
    const purgeTarget = requireReadableRow(
      c,
      await storage.items.getIncludingTrashed(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found"),
    );
    refuseUnlessUninstalled(purgeTarget);

    // The key's type map is asked whatever state the row is in, as restore
    // and the bulk purge ask it: a key that may only read a type destroys
    // none of its rows, trashed or not.
    //
    // The reserved-namespace fence is asked only of a row not yet
    // soft-deleted. There it names the real reason (no credential trashes a
    // `system.*` row), where the state check below would read as an ordering
    // mistake. A reserved row already soft-deleted got there by a cascade or
    // an archive restore; no credential gets past the fence and the map both,
    // so asking the fence would strand the row for good.
    //
    // The state is the type's own soft-deleted state, not the literal
    // `trashed`: a `system.connection` ends `revoked`, and
    // `storage.items.purge` gates on the same derived state.
    if (purgeTarget.state === softDeleteState(purgeTarget.type)) {
      checkTypePermission(c.get("apiKey"), purgeTarget.type, "write");
    } else {
      checkTypeAccess(c.get("apiKey"), purgeTarget.type, "write");
    }

    // **No provenance guard here**, and that is a finding rather than an
    // omission: a row is refused or purged by the permission asked above and
    // the type gate, and nothing marks a row as one writer's rather than
    // another's. A guard here would be unreachable code no test could pin,
    // which is worse than none because it reads as a protection somebody is
    // relying on.
    // Edges have no FK to items — explicit cleanup required before purge.
    // Every edge the purge takes with it, announced individually. A
    // subscriber holding a graph cannot infer these from the item's own
    // removal: an edge pointing AT the purged item lives on another item,
    // and nothing else tells that item's holder it lost a relationship.
    //
    // All three writes in one transaction. Edges are the only record that
    // two items were related, so losing them while the row survives is not
    // recoverable from anything the caller holds — and the caller was told
    // the purge failed, so its own copy still has both. The wrapper the
    // request already runs inside is not a rollback boundary: a handler
    // that throws still commits, because the error is caught inside the
    // composed chain and the transaction closes normally. A door that wants
    // atomicity has to open its own.
    // Read before the purge, which takes the mark with the row.
    const trashedWith = (await storage.items.cascadeMarks([id])).get(id);
    const cascaded = await storage.runInTransaction(async () => {
      const removed = [
        ...(await storage.edges.deleteBySource(id)),
        ...(await storage.edges.deleteByTarget(id)),
      ];
      await storage.items.purge(id);
      return removed;
    });
    for (const edge of cascaded) {
      await publishEdge({ type: "edge_deleted", edge, purgedWith: id });
    }
    // The item itself, which the cascade above does not cover. A trashed
    // row announced `item.deleted`, which says recoverable; nothing else
    // says the row has gone, and no later event can, because the row is
    // absent rather than changed. Without this a client holding it would
    // keep it until a full re-import, and one offline across the purge
    // would never learn it happened.
    //
    // Last, mirroring the ordering a create states in reverse: an edge
    // arrives behind the item it belongs to, so a removal puts the edges
    // first and the row they hang off after them.
    //
    // The snapshot read before the purge, because there is nothing left to
    // read afterwards.
    await publish({
      type: "purged",
      item: purgeTarget,
      ...(trashedWith && { trashedWith }),
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.purge",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(removeTagRoute, async (c) => {
    // The tag is used as the router hands it over. Hono decodes a path
    // parameter exactly once, so decoding it again is not defensive: it
    // corrupts a value that was already correct. Decoded twice, a tag
    // holding a literal percent would throw on the second decode and
    // answer 500, while one whose text happened to look like an escape
    // would decode into a different tag and remove nothing, silently.
    const { id, tag } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.
    const metadata = await storage.metadata.removeTag(id, tag);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.untag",
      resource_type: "item",
      resource_id: id,
      details: { tag },
    });
    await publish({
      type: "metadata_changed",
      item: await itemAfterMetadataWrite(storage, item),
      metadata,
    });
    return c.json(
      { metadata: filterMetadataForCaller(metadata, c.get("apiKey")) },
      200,
    );
  });

  return router;
}
