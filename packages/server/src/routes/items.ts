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
  isTypeInStrictMode,
  getSourceAllowlist,
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
  itemProvenanceSource,
  requireMirrorProtection,
  requireDeclaredTypeMatches,
  checkTypeAccess,
  requireEdgePermission,
  getTypeFilter,
  CONNECTOR_SOURCE_PREFIX,
} from "../middleware/auth.js";
import { compareProperties } from "./mirror-reconcile.js";
import type {
  Storage,
  ItemSortField,
  ResolvedItem,
} from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { planCascadeDelete } from "../storage/edge-cascade.js";
import { assertEdgesCanBeCreated } from "../storage/edge-constraints.js";
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
  MetadataSchema,
  ALL_STATES,
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
 * Declared once because two things read it now: the clause builder that
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

const ConflictSnapshotSchema = z.object({
  version: z.number(),
  properties: z.record(z.string(), z.unknown()),
});

const MergeStrategySchema = z.enum(["last_writer_wins", "keep_both_copies"]);

const MergePolicySchema = z.object({
  fields: z.record(z.string(), MergeStrategySchema).optional(),
  default: MergeStrategySchema.optional(),
});

const ConflictResponseSchema = z.object({
  error: z.object({
    code: z.literal("version_conflict"),
    status: z.literal(409),
    /** Prose for a person. Branch on `code`, never on this. */
    message: z.string(),
  }),
  current: ConflictSnapshotSchema,
  ancestor: ConflictSnapshotSchema,
  conflicting_fields: z.array(z.string()),
  merge_policy: MergePolicySchema,
});

/**
 * The refusal for a write based on a version whose snapshot has been thinned
 * away. Distinct from `version_conflict` because it cannot be resolved: there
 * is no ancestor, so no field can be shown not to have collided, and a client
 * merging against an empty one spawns siblings holding text nobody typed.
 */
const AncestorUnavailableSchema = z.object({
  error: z.object({
    code: z.literal("ancestor_unavailable"),
    status: z.literal(409),
    message: z.string(),
  }),
  current: ConflictSnapshotSchema,
  requested_version: z.number(),
});

/**
 * Who resolves a collision on this write.
 *
 * A closed enum rather than a free string, so a caller asking for a mode this
 * server does not implement is refused. Dropping it instead would answer 409
 * to a request that asked for a resolution, which reads as "no conflict was
 * resolvable" rather than "nobody read your parameter".
 */
const ConflictModeSchema = z.enum(["auto", "manual", "callback"]);

/**
 * The 200 for an update, widened by what the server did if it resolved a
 * collision. Absent on every write that did not, which is nearly all of them.
 */
const UpdatedItemSchema = ItemWithMetadataSchema.extend({
  conflict_resolution: z
    .object({
      fields: z.array(z.string()),
      strategy: z.record(z.string(), MergeStrategySchema),
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
    "Creates an item, validating its properties against the registered type schema before the write; a schema failure rejects the whole item. The server stamps identity, timestamps, version, and the source credential, so passing a `source_id` that already exists for that source upserts the existing item and returns 200 instead of 201. Passing an `id` the caller already created is treated the same way: the create is a repeat of one the server has performed, so nothing is written, no event is published, and the stored item comes back with `acknowledged: true`.",
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
            source: z.string().optional(),
            source_id: z.string().optional(),
            version: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                "Optional, and meaningful on one path: a `source_id` resolving a live row makes this write an upsert, and a version here makes that upsert conditional exactly as it is on the update door. Everywhere else it is ignored, because nothing is overwritten — a genuine create has no version to have read, and a repeated `id` or a natural key resolving a trashed row is acknowledged rather than written.",
              ),
            tier: z.enum(["library", "feed"]).optional(),
            device: z.string().optional(),
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
        "`source` (stamped from the credential) and request `source_id` " +
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
      description: "Forbidden",
    },
    409: {
      content: {
        "application/json": {
          schema: z.union([
            ConflictResponseSchema,
            AncestorUnavailableSchema,
            makeErrorResponseSchema(["conflict", "type_mismatch"]),
          ]),
        },
      },
      description:
        "`type_mismatch`: the request resolved an existing item — by the " +
        "`(source, source_id)` natural key or by a repeated `id` — whose " +
        "type is not the one declared. Re-typing an item is a deliberate " +
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

const promoteItemRoute = createRoute({
  operationId: "promoteItem",
  method: "post",
  path: "/{id}/promote",
  tags: ["Items"],
  summary: "Promote a connector's copy into your own item",
  description:
    "Mints a new item you own from a connector's mirror of an external record, joined back to the mirror by a `derived-from` edge. The mirror stays a faithful copy the connector keeps re-syncing; the promoted item is yours to edit and is never touched by a re-sync. Only items a connector owns can be promoted.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ item: z.record(z.string(), z.unknown()) }),
        },
      },
      description: "Promoted item created",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            // Reachable, though not from anything the caller sends: the copy
            // takes the mirror's properties verbatim and they are validated
            // on write, so a type whose required list tightened after the
            // mirror was stored refuses the copy it would once have
            // accepted.
            "invalid_properties",
          ]),
        },
      },
      description:
        "The item is not a connector's copy, or its properties no longer satisfy its type",
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

const ReconcileFieldSchema = z.object({
  key: z.string(),
  state: z.enum(["same", "diverged", "only_yours", "only_mirror"]),
  yours: z.unknown().optional(),
  mirror: z.unknown().optional(),
});

const ReconcileResponseSchema = z.object({
  mirrors: z.array(
    z.object({
      mirror_id: z.string(),
      mirror_type: z.string(),
      mirror_source: z.string(),
      mirror_updated_at: z.string(),
      fields: z.array(ReconcileFieldSchema),
    }),
  ),
});

const reconcileItemRoute = createRoute({
  operationId: "reconcileItem",
  method: "get",
  path: "/{id}/reconcile",
  tags: ["Items"],
  summary: "Compare your item against the mirror it was promoted from",
  description:
    "Reports, field by field, where your item and the connector's mirror now differ. Promotion forks a copy; the mirror keeps re-syncing, so this is how you see what moved upstream since. Accepting a field is an ordinary `PATCH` on your own item, so nothing here writes. Reports against every mirror the item is joined to by `derived-from`.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: {
        "application/json": { schema: ReconcileResponseSchema },
      },
      description: "Field-by-field comparison against each mirror",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "The item was not promoted from a connector's copy",
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
        .describe(
          "Grouping axis. Defaults to `state`, which is what this route has always returned.",
        ),
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
  },
});

const listItemsRoute = createRoute({
  operationId: "listItems",
  method: "get",
  path: "/",
  tags: ["Items"],
  summary: "List items",
  description: `Returns a paginated list of items, narrowed by the query parameters; a \`type\` filter matches subtypes via inheritance. Lists are lean by default — use \`include\` to hydrate edges, metadata, or extensions inline and avoid an N+1. That same parameter also takes \`system\`, which is not a hydration: it widens the rows returned to include \`system.*\` items, which this listing omits by default. ${UNKNOWN_PARAM_NOTE}`,
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
          `Filter by lifecycle state. \`${ALL_STATES}\` returns every state including trashed, which a resuming client needs in order to see a row go to the bin; omitting the parameter keeps the default, which excludes trashed rows.`,
        ),
      source: z.string().optional().describe("Filter by source credential"),
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
        .describe("Filter expression in the query grammar"),
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
          schema: z.union([
            z.object({
              data: z.array(ItemSchema),
              cursor: z.string().nullable(),
              has_more: z.boolean(),
            }),
            z.object({
              data: z.array(ItemWithMetadataSchema),
              cursor: z.string().nullable(),
              has_more: z.boolean(),
            }),
          ]),
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
  },
});

const getItemRoute = createRoute({
  operationId: "getItem",
  method: "get",
  path: "/{id}",
  tags: ["Items"],
  summary: "Get an item",
  description:
    "Returns a single item with its metadata layer and outbound edges hydrated inline; extensions are not included. An item the caller cannot see returns 404 rather than 403, so the server never leaks existence.\n\n" +
    "`?include=` widens the response with the item's 1-hop neighborhood in one round trip instead of a per-section fan-out: `backrefs` adds inbound edges grouped by type (same block shape as `edges`, capped + cursored per type); `neighbors` adds the far-end items of the item's edges (outbound targets, plus inbound sources when `backrefs` is also requested), each with its metadata and filtered to what the caller may read; `versions` adds the item's version snapshots newest-first. Tokens are comma-separated and compose.",
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

const updateItemRoute = createRoute({
  operationId: "updateItem",
  method: "patch",
  path: "/{id}",
  tags: ["Items"],
  summary: "Update an item",
  description:
    "Updates an item's properties, tier, own time, edges, or natural key. Properties merge shallowly with existing values by default, or become the item's properties outright when `properties_mode` is `replace`, while tier and `occurred_at` always replace; `version` is required, a stale value returns 409 with the conflict context to resolve, and a write naming none is refused 400 `missing_required_field`. An item's `type` is not updatable here by default: sending one that matches the item is accepted and ignored, and sending a different one is refused with 409 `type_mismatch` rather than silently dropped. Passing `retype: true` alongside a different `type` moves the item to it — that requires write on the type being entered as well as the one being left, and the resulting properties are validated against the destination.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      conflict: ConflictModeSchema.optional().describe(
        "Who resolves a version conflict. `auto` resolves it here, in this " +
          "write's transaction, by the type's merge policy: a " +
          "`last_writer_wins` field takes this write's value, a " +
          "`keep_both_copies` field leaves the server's value on the item " +
          "and the losing value lands on a sibling tagged `conflicted-copy`. " +
          "`manual` and `callback` return the 409 envelope for the caller to " +
          "resolve. Omitted means `manual`.",
      ),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            properties: z.record(z.string(), z.unknown()).optional(),
            /** The item's own type, and only that. This route does not
             *  re-type the row it addresses, so the field exists to be
             *  checked rather than applied: equal to the item's type it is
             *  accepted and ignored, anything else is refused.
             *
             *  Present in the schema at all because callers send it
             *  constantly. The fleet builds one input object and hands it
             *  to either the create or the update call, so a type rides on
             *  nearly every reactive update. It used to be stripped here
             *  in silence, which is how a re-type could be attempted,
             *  answered with a 200, and do nothing. */
            type: z.string().optional(),
            /** Whether `properties` lays over the item's or becomes them.
             *  Defaults to `merge`, which is what every caller before this
             *  meant. A `replace` says the set sent IS the item's
             *  properties, so a field the row holds and this write does not
             *  name is removed. The result is validated either way, so a
             *  replace dropping a required field is refused rather than
             *  written. */
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
            force_snapshot: z.boolean().optional(),
            /** Toggle the tier (`library` ↔ `feed`). Independent of the
             *  properties merge path — last-writer-wins. */
            tier: z.enum(["library", "feed"]).optional(),
            /** Override the item's own time (ISO 8601).
             *  Last-writer-wins like `tier`. */
            occurred_at: z.string().optional(),
            /** Repoint at a new natural-key identifier under the item's
             *  `source` (the server-stamped value, not the caller's). The
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
    // `connector_owned` was reachable here and declared by no operation in
    // the document at all. A caller can arrange it: `POST
    // /admin/restore-archive` writes `item.source` through verbatim, so an
    // archive carrying the connector prefix mints a row this door then
    // refuses.
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "type_not_permitted",
            "connector_owned",
          ]),
        },
      },
      description:
        "`type_not_permitted`: the credential does not hold write on the item's type. `connector_owned`: the row is a connector's copy of an external record, which only the owning connector writes — promote it first and edit your own copy.",
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
      description: "Item not found",
    },
    409: {
      content: {
        "application/json": {
          schema: z.union([
            ConflictResponseSchema,
            AncestorUnavailableSchema,
            makeErrorResponseSchema([
              "version_conflict",
              "source_id_conflict",
              "type_mismatch",
            ]),
          ]),
        },
      },
      description:
        "Version conflict — a stale `version`, whether the write carried properties to merge or only edges, `ancestor_unavailable` (the base version's snapshot has been thinned, so the write cannot be merged and is never auto-resolved), `source_id_conflict` (target natural key already in use by another item under the item's `source`), or `type_mismatch` (the request declared a `type` that is not this item's).",
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
    "Moves the item to the trashed state, reversible via restore until the retention window expires, after which it is purged permanently. For immediate, irreversible removal use the purge endpoint instead. A live `system.connection` is refused: an app grant is revoked through the grants routes first, so its tokens and stored consent go with it.",
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
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "The item is a live `system.connection`. Revoke the app grant through `DELETE /auth/grants/{id}` first: removing the row here would leave the app's tokens and stored consent behind with nothing naming their owner.",
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
          schema: z.object({ metadata: MetadataSchema }),
        },
      },
      description: "Item metadata",
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
          schema: z.object({ metadata: MetadataSchema }),
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
          schema: z.object({ metadata: MetadataSchema }),
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
          schema: z.object({ metadata: MetadataSchema }),
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
          schema: z.object({ metadata: MetadataSchema }),
        },
      },
      description: "Tag removed",
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

const purgeItemRoute = createRoute({
  operationId: "purgeItem",
  method: "delete",
  path: "/{id}/purge",
  tags: ["Items"],
  summary: "Permanently delete an item",
  description:
    "Hard-deletes the item and its edges, metadata, extensions, and attachment references — irreversible, and requires `items.purge`. Content-addressed blob bytes are retained if other items still reference them; most clients want the soft-delete endpoint instead. A live `system.connection` is refused: an app grant is revoked through the grants routes first, so its tokens and stored consent go with it.",
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
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "The item is a live `system.connection`. Revoke the app grant through `DELETE /auth/grants/{id}` first: removing the row here would leave the app's tokens and stored consent behind with nothing naming their owner.",
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
        "`items.purge` is missing, or the item is in a reserved namespace this credential may not write. The second reads `type_not_permitted` and is the answer for an untrashed row: purging is trash-then-purge, and a credential refused at the trash door would otherwise be told only that the item is not trashed, which describes an ordering mistake it did not make.",
    },
  },
});

/**
 * The body of an acknowledged re-send: the row as it already stands.
 *
 * Two doors reach this, and they are the same answer to the same
 * question — a create the server has already performed, arriving again.
 * One resolves the row by `(source, source_id)` after the user trashed
 * it; the other resolves it by an `id` the caller minted and is sending
 * a second time because it never learned the first attempt landed.
 * Neither writes, and neither publishes.
 *
 * Shared rather than written twice because the disclosure rules are the
 * subtle part: the metadata is filtered to the caller's own extension
 * permissions, and the orphan state is resolved the way every other
 * own-write response resolves it. A second copy is a second place for
 * one of those to be forgotten.
 */
async function acknowledgedItemBody(
  storage: Storage,
  apiKey: ApiKey | undefined,
  existing: Item,
): Promise<{ item: Item; metadata: Metadata; acknowledged: true }> {
  const metadata = await storage.metadata.get(existing.id);
  return {
    item: existing,
    metadata: filterMetadataForCaller(metadata, apiKey),
    acknowledged: true,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

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
    // A create is not a transition, so it reached none of the graph, and a
    // membership test against the universal state list is a weaker question
    // than the one that matters: `trashed` is a valid state and is not in
    // the `system.*` lifecycle at all. The operator key could therefore
    // create a `system.connection` directly in `trashed` — a state no
    // transition can produce and none can leave — and then restore it into
    // `active` having passed nothing the graph admits.
    //
    // Asking `validateTransition` what the default start state can reach
    // gives each type its own answer with no second table to keep in step:
    // a non-system type gets `active | archived | trashed`, a `system.*`
    // type gets `active | revoked`. It also still rejects a state that is
    // not a state, so the universal check it replaces is subsumed rather
    // than dropped.
    //
    // **In the route, not in `storage.items.create`**, and the asymmetry
    // with `items.restore()` is deliberate. The store's `create` is also
    // the archive restore's writer (`POST /admin/restore-archive` calls it
    // directly with the archived `state`), and an archive is a faithful
    // record of rows written before this rule existed. Tightening the store
    // would make those archives unrestorable, which is a worse failure than
    // the inconsistency being closed here. The lifecycle gate that DOES
    // belong in the store is the one on `restore()`, because a restore is a
    // transition and its two siblings live there.
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

    // The items quota is reserved around the write itself, further down,
    // rather than checked here. A count taken at this point is a check
    // against a number the write is about to change, so N concurrent
    // creates each see room and the count lands at limit + N - 1.

    if (Array.isArray(body.tags) && body.tags.length > MAX_TAGS_PER_ITEM) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
      );
    }

    // Schema-enforcement levers: source allow-list, strict-mode, and
    // custom sources. Off by default; enabled per type via the instance
    // config or per-credential override.
    const instanceConfig = await readInstanceConfig(storage.settings);
    const enforcement = resolveEnforcement(instanceConfig, c.get("apiKey"));

    // source is non-forgeable: always stamped from the credential.
    // tier falls back to the credential default when absent.
    // Final fallback is `tier: "library"` — the curated layer is the
    // intended default when neither caller nor credential expresses intent.
    const credential = c.get("apiKey");
    const stampedSource = itemProvenanceSource(credential);

    // Source allow-list: when configured for this type, the credential's
    // source must appear in the allowed list.
    const allowedSources = getSourceAllowlist(enforcement, type);
    if (
      allowedSources !== null &&
      (stampedSource === undefined || !allowedSources.includes(stampedSource))
    ) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Source "${stampedSource ?? "(unknown)"}" is not in the allow-list for type ${type}`,
        { type, source: stampedSource, allowed: allowedSources },
      );
    }

    // Strict-mode lever: when configured for this type, unknown properties
    // are rejected. Storage's own validateProperties runs in loose mode
    // regardless; this pre-check catches strict-mode violations before any
    // persistence work.
    if (
      isTypeInStrictMode(enforcement, type) &&
      getTypeSchema(type) !== undefined
    ) {
      const strictResult = validateProperties(type, properties, {
        strict: true,
      });
      if (!strictResult.success) {
        throw new MarfaError(
          ErrorCode.INVALID_PROPERTIES,
          "Unknown property: strict mode rejects properties not declared in the type schema",
          {
            errors: strictResult.errors,
            code: "unknown_property",
          },
        );
      }
    }
    // `system.*` items have no tier; reject explicit values on write, and
    // stamp `undefined` rather than the library default.
    //
    // Asked through the same predicate the delete door uses, so the two
    // cannot answer differently for a reserved-root type this build did not
    // seed: one refusing the tier while the other still stamps a default is
    // how a platform record ends up with a field its own lifecycle has no
    // room for.
    // The refusal comes from the shared rule rather than a copy of it. This
    // door had its own, with the same message, in the file that already
    // imports the rule for the update door — which is the disagreement
    // `_tier-rules.ts` was written to prevent, surviving inside one of the
    // doors it was written for.
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

    // Natural-key upsert. When both `source` (stamped from the credential)
    // and request `source_id` are present, look up an existing non-trashed
    // row by (source, source_id). If one matches,
    // short-circuit to update so `POST /items` is idempotent on re-sync —
    // the contract that lets inbound connector handlers recover from
    // whole-batch retries (createItem-success / cursor-write-fail) without
    // producing duplicates. Returns 200 on this branch (vs 201 on create) so
    // the caller can distinguish the realized effect.
    //
    // Update semantics: properties / tier / occurred_at via `ItemStore.update`
    // (shallow-merge); tags via `metadata.set`; edges via `applyInlineEdges`
    // (replace-by-edge-type). Fields only meaningful at create time (id,
    // state, device, capture_*) are ignored — the existing row's id wins.
    if (stampedSource && body.source_id) {
      // Including trashed rows, deliberately. `findBySourceId` hides them,
      // which sent a re-sync of a mirror the user had deleted into the
      // create path, where `create`'s own dedup pre-check — which does not
      // filter state — found the same row and refused with a 409. That 409
      // never clears: the row stays trashed, so every subsequent sync
      // fails the same way and the connector is wedged on one item.
      const existing = await storage.items.findBySourceIdIncludingTrashed(
        stampedSource,
        body.source_id,
      );
      // D63 is checked on BOTH arms below rather than once here, and the
      // difference is disclosure. This branch reasons carefully that the
      // row's type is a gate rather than a filter — gate before disclosing,
      // so a refusal cannot be read off the body — and the provenance
      // refusal names `item_id`, `source` and the owning connection's id.
      // Answering it ahead of `requireTypeAccess` would disclose all three
      // to a caller the type gate is about to refuse and tell nothing.
      //
      // So each arm runs it last among its own gates. That is two call
      // sites for one rule, which is the shape this codebase treats as a
      // hazard — the trashed arm has its own named test for exactly that
      // reason, and deleting either call reddens one case and only one.
      if (existing?.state === "trashed") {
        // The user deleted this. Reviving it would overturn that decision
        // silently, and refusing forever is the bug being fixed, so the
        // sync is acknowledged and nothing is written or published.
        //
        // **What the acknowledgment may disclose, stated rather than left
        // to where this `return` sits.** The natural key bounds some axes
        // and not others, and only the ones it bounds are safe to answer on:
        //
        //  - The row itself is disclosed, because every part of reaching it
        //    is already the caller's own. `source` is stamped from the
        //    credential and cannot be chosen, and the `source_id` came from
        //    this request.
        //  - The extension namespaces are NOT, because that axis is not
        //    bounded by the natural key. `extension_permissions` are per
        //    credential, so a row can carry namespaces this caller holds
        //    nothing on — written by a person or by another tool. Hence the
        //    same filter the other eleven sites in this file use.
        //  - The type is NOT either, and that is a gate rather than a
        //    filter. A credential's `source` is stable for its life, so a
        //    credential whose type map has since narrowed still resolves
        //    rows whose type it has lost. The update branch below refuses
        //    those on the resolved row's type; refusing here too is what
        //    makes the two branches agree about who may address one row,
        //    instead of the answer depending on whether the user happened
        //    to have trashed it.
        //
        // Gate before disclosing, so a refusal cannot be read off the body.
        requireTypeAccess(c, existing.type, "write");
        // A write never re-types the row it lands on, and an
        // acknowledgment is a write's answer. Without this the arm
        // accepted a body naming any type at all, which is what made the
        // route's own 409 description untrue of it.
        requireDeclaredTypeMatches(type, existing);
        return c.json(
          await acknowledgedItemBody(storage, c.get("apiKey"), existing),
          200,
        );
      }
      if (existing) {
        // Authorize the update against the row it lands on, not the body
        // that addressed it. Every gate above ran on `type`, which the
        // caller chose and which this branch never writes — the update
        // takes the resolved row's type as it stands. Naming a type the
        // credential holds write on therefore admitted an edit to a row
        // of any other type, and skipped every gate keyed on the real
        // one. These are the gates `PATCH /items/{id}` runs; running them
        // here is what makes the two doors agree. The create path below
        // keeps authorizing the claim, because there the claim is the row.
        requireTypeAccess(c, existing.type, "write");
        // **No mirror check here, and its absence is the honest shape.**
        // Every other door that resolves a row calls
        // `requireMirrorProtection`; this one cannot be reached by a
        // connector's mirror at all, so a call would be a guard that can
        // never refuse — which reads as protection while making no claim.
        //
        // The lookup is what provides the property. `stampedSource` is the
        // credential's own `source` and `findBySourceIdIncludingTrashed`
        // keys on it, so a row resolved here carries this credential's own
        // source by construction, and `isReservedCredentialSource` refuses
        // a `connector:` source at every mint. The answer is decided
        // before the row is read.
        //
        // **A lookup that ever resolves a row by something other than the
        // caller's own stamp owes a mirror check here.** That is the change
        // this note is for.

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
        // natural key lands on another used to be merged in silently.
        // Shared with the bulk door rather than written twice: the last
        // time a rule lived at one door and not its neighbors, four of
        // six were found disagreeing.
        requireDeclaredTypeMatches(type, existing);

        // This branch used to be the one write path that skipped property
        // validation, and it is also the one where a null removes a value
        // rather than setting it. A re-sync sending a null title therefore
        // deleted a field `core.event` declares required, leaving a row that
        // could not have been created in the state it now sat in, with a 200
        // and no signal. Judged on the merged result rather than the body,
        // mirroring the merge the storage layer performs: a body naming no
        // required field at all can still be what removes one.
        if (
          body.properties !== undefined &&
          getTypeSchema(existing.type) !== undefined
        ) {
          const merged = mergeUpdateProperties(
            existing.properties,
            resolveIncomingProperties(existing.type, properties, false),
            false,
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
    // cannot.** The pre-check has to exist because the write path is not
    // reachable at every moment the acknowledgment is owed: the
    // transaction reserves quota before it inserts, so an instance at its
    // item ceiling would answer a repeat with `quota_exceeded` for a row
    // it already holds — the same permanent refusal in another code. The
    // catch has to exist because the pre-check races: two sends of one id
    // can both find nothing, and the loser of the insert still needs an
    // answer other than 409.
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
      // Nothing visible means the id belongs to a row this caller cannot
      // read — a type it holds no permission for. It stays a conflict
      // because the server cannot tell whether this is the caller's own
      // earlier write, and the caller learns only that the id it chose is
      // taken, which it already told us.
      if (!existing) return null;

      // **No type gate of its own here, and its absence is the honest
      // shape.** `requireDeclaredTypeMatches` below is exact, so a row
      // that is acknowledged has the type the body named — and that type
      // already cleared `requireTypeAccess` at the top of this route. A
      // second call could therefore never refuse, and a gate that cannot
      // refuse reads as a protection somebody is relying on.
      //
      // The natural-key arms do carry one, and the difference is real:
      // they resolve by `(source, source_id)`, which says nothing about
      // the row's type, so the row can be a type the caller may not
      // write.
      //
      // A write never re-types the row it lands on, on any door. Shared
      // with the natural-key branch and the bulk door rather than
      // restated.
      requireDeclaredTypeMatches(type, existing);
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
        await acknowledgedItemBody(storage, c.get("apiKey"), alreadyHeld),
        200,
      );
    }

    let writeResult;
    try {
      writeResult = await storage.runInTransaction(async () => {
        // The reservation is the first thing in this transaction and holds for
        // the rest of it, so the count it reads includes every create already
        // committed against the instance's ceiling.
        const created = await storage.items.create({
          type,
          properties,
          id: body.id,
          state: body.state as ItemState | undefined,
          tier: tierValue,
          occurred_at: body.occurred_at,
          source: stampedSource,
          source_id: body.source_id,
          device: body.device,
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
        await acknowledgedItemBody(storage, c.get("apiKey"), raced),
        200,
      );
    }
    const { item, metadata, createdEdges } = writeResult;

    // Sorted to the store's exact read order (created_at DESC, id DESC)
    // before grouping: groupAndCap's cap and cursor logic assume it, and
    // body order fed in raw returned the OLDEST fifty of a large batch
    // with a cursor that re-fetched them and never reached the newest.
    const orderedEdges = [...createdEdges].sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    );
    const itemWithEdges = {
      ...item,
      edges: groupAndCap(orderedEdges, HYDRATE_PER_TYPE_CAP),
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

  router.openapi(promoteItemRoute, async (c) => {
    requireAuth(c);
    const credential = c.get("apiKey");
    const { id } = c.req.valid("param");

    const mirror = await storage.items.get(id);
    if (!mirror) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    if (!mirror.source.startsWith("connector:")) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Only a connector's copy can be promoted; this item is already yours",
        { item_id: id, source: mirror.source },
      );
    }
    requireTypeAccess(c, mirror.type, "write");
    requireEdgePermission(c, "derived-from", "write");

    // One transaction, because the copy without its edge is not a partial
    // promotion — it is an untraceable duplicate that no query relates to
    // its origin, and nothing stored says where it came from. The
    // caller is told the promotion failed either way, so a copy that
    // outlives the failure is a row nobody asked for and nobody is looking
    // for. The wrapper the request already runs inside is not a rollback
    // boundary: a handler that throws still commits, because the error is
    // caught inside the composed chain and the transaction closes normally.
    const { promoted, promotionEdge } = await storage.runInTransaction(
      async () => {
        // The copy is yours: caller-stamped provenance, no natural key (the
        // upstream record's identity stays with the mirror), library tier.
        const created = await storage.items.create({
          type: mirror.type,
          properties: { ...mirror.properties },
          tier: "library",
          ...(itemProvenanceSource(credential) !== undefined
            ? { source: itemProvenanceSource(credential) }
            : {}),
        });
        // derived-from is many-to-many with orphan cascade and the source is
        // a freshly minted node, so the raw write cannot violate cardinality
        // or create a cycle.
        const edge = await storage.edges.createRaw({
          source_id: created.id,
          target_id: mirror.id,
          edge_type: "derived-from",
          properties: {},
        });
        return { promoted: created, promotionEdge: edge };
      },
    );
    // The item first, then the edge that joins it back to the mirror, which
    // is the ordering `POST /items` states for the same pair: an edge
    // arrives behind the item it belongs to, so a subscriber resolving an
    // edge's endpoints has already been told the new one exists.
    //
    // This door used to announce the edge alone, on the reasoning that an
    // item event here would be a new contract. It is the other way round —
    // a subscriber was handed an `edge_created` naming a `source_id` it had
    // never heard of and could not resolve, and a durable client persisting
    // the stream never learned the row existed at all, short of a full
    // re-import. The promoted copy is a new row written by an ordinary
    // write door, and every other such door announces one.
    //
    // `metadata` is the literal the create door builds for the same reason:
    // a fresh row's metadata layer is exactly what the write put there, and
    // a promotion writes no tags. Carrying it is not tidiness. `publish`
    // omits the key entirely when it is absent, so the webhook sends
    // `metadata: null` and the connector envelope sends nothing at all —
    // a handler reading `payload.metadata.tags`, which is safe on every
    // other `item.created`, would throw on this one alone.
    //
    // `enableFanout: false`, which is the one thing a promotion must not do.
    // The mirror is a connector's reflection of an upstream record;
    // pushing the copy back out makes that connector create a SECOND
    // upstream record for the thing the mirror already reflects, which is
    // the duplication the mirror-and-promote split exists to prevent.
    // Dispatch has nothing left to suppress a write on, so nothing else
    // would stop it. Declining costs
    // this announcement nothing: fan-out governs neither the event log nor
    // the stream, and those are what the announcement is for.
    await publish({
      type: "created",
      item: promoted,
      metadata: { item_id: promoted.id, tags: [], extensions: {} },
      enableFanout: false,
    });
    await publishEdge({
      type: "edge_created",
      edge: promotionEdge,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: credential?.id,
      action: "item.promote",
      resource_type: "item",
      resource_id: promoted.id,
      details: { mirror_id: mirror.id, type: mirror.type },
    });
    return c.json(
      {
        item: promoted,
      },
      201,
    );
  });

  router.openapi(reconcileItemRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");

    const yours = await storage.items.get(id);
    if (!yours) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    requireTypeAccess(c, yours.type, "read");

    const joined = await storage.edges.listFromSource(id, {
      edge_type: "derived-from",
    });
    const mirrors = [];
    for (const edge of joined.data) {
      const mirror = await storage.items.get(edge.target_id);
      // A derived-from edge can join any two items; only the ones a
      // connector owns are mirrors, and only those have anything to
      // reconcile against.
      if (!mirror?.source.startsWith(CONNECTOR_SOURCE_PREFIX)) continue;
      requireTypeAccess(c, mirror.type, "read");
      mirrors.push({
        mirror_id: mirror.id,
        mirror_type: mirror.type,
        mirror_source: mirror.source,
        mirror_updated_at: mirror.updated_at,
        fields: compareProperties(yours.properties, mirror.properties),
      });
    }
    if (mirrors.length === 0) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "This item was not promoted from a connector's copy, so there is nothing to reconcile against",
        { item_id: id },
      );
    }
    return c.json({ mirrors }, 200);
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
      // A shorthand with nothing after the `=` used to be skipped here,
      // which returned an unfiltered page at 200 — the failure the
      // unknown-parameter refusal exists to remove, reached through the
      // exemption that keeps the shorthand working. The exemption matches
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
    // than restated here: this sentence was written out twice and omitted
    // once, and the door that omitted it matched rows its siblings hide.
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

    const ids = result.data.map((item) => item.id);
    const apiKey = c.get("apiKey");
    const edgesMap = includeEdges
      ? await hydrateEdgesForItems(storage, ids)
      : null;
    const extensionsMap = includeExtensions
      ? await hydrateExtensionsForItems(storage, ids, apiKey)
      : null;
    const decorate = (item: (typeof result.data)[number]) => {
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
          data: result.data.map((item) => ({
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
          cursor: result.cursor,
          has_more: result.has_more,
        },
        200,
      );
    }

    return c.json(
      {
        data: result.data.map(decorate),
        cursor: result.cursor,
        has_more: result.has_more,
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
    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");

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
      hydrateEdgesForItem(storage, id),
      includeBackrefs
        ? hydrateBackrefsForItem(storage, id)
        : Promise.resolve(null),
      includeVersions ? storage.versions.list(id) : Promise.resolve(null),
    ]);

    let neighbors: { item: Item; metadata: Metadata }[] | undefined;
    // True when the 1-hop neighbor set was capped (more neighbors exist than
    // were hydrated). Distinct from the per-type edge-block `has_more`: several
    // edge types can each sit below their per-type cap while their COMBINED
    // neighbor set exceeds the bound, so this is the only signal that catches
    // that case. Consumers must treat every neighbor-derived view as
    // incomplete when this is set and page the per-type edge/backref endpoints.
    let neighborsTruncated = false;
    // How many neighbors the caller may not read. Omitting them is right —
    // a neighbor outside the caller's scope must never leak — but omitting
    // them *silently* made a partial neighborhood indistinguishable from a
    // complete one. An app missing an edge scope rendered a ticket with none
    // of its relations and looked correct doing it.
    let neighborsOmitted = 0;
    if (includeNeighbors) {
      // The 1-hop neighborhood: the far-end items of the edge blocks present
      // in this response — outbound targets always, inbound sources when
      // `backrefs` was also requested. Each neighbor is re-authorized through
      // the same per-type read gate the bulk-get path uses, so a
      // neighbor the caller cannot read is silently omitted, never leaked.
      const neighborIds = new Set<string>();
      for (const block of Object.values(edges)) {
        for (const e of block.edges) neighborIds.add(e.target_id);
      }
      if (backrefs) {
        for (const block of Object.values(backrefs)) {
          for (const e of block.edges) neighborIds.add(e.source_id);
        }
      }
      neighborIds.delete(id);

      // Bound the hydration so a pathological fan-out can't pin the worker. When
      // the bound bites, `neighbors_truncated` flags it — the per-block
      // `has_more` does NOT cover this, since the cap is on the combined set
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
        ...(includeVersions && versions ? { versions } : {}),
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
    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

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
    // the three sites below that need it to be one.
    const retypeTo = body.retype === true ? body.type : undefined;
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

    requireMirrorProtection(item);

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
    // **Kept after the collapse onto `applyInlineEdges`, and not because
    // it refuses earlier — the helper's permission gate and its id and
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

    if (body.properties) {
      // Through the shared helper rather than a shallow spread of its own,
      // because this has to predict exactly what the store will write. A
      // hand-rolled copy was a fourth version of a rule that already had
      // three, and it silently stopped agreeing the moment a caller could
      // ask for a replace: it would have validated the merged set while the
      // store wrote the replaced one, so a write dropping a required field
      // passed validation on the strength of the value it was removing.
      // The type the row ends up as, which is what the resulting
      // properties have to satisfy. Validating against the type being left
      // would admit a move whose result the destination calls invalid,
      // which is the whole hazard of moving a corpus.
      const resultingType = retypeTo ?? item.type;
      const merged = mergeUpdateProperties(
        item.properties,
        resolveIncomingProperties(resultingType, body.properties, false),
        false,
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

    // Pre-validate the edges payload before any mutation: edge type
    // exists, each target item exists + type-constraint-compatible, and
    // (after-delete) cardinality stays within bounds. Fast-fails on bad
    // input before the delete-and-create pass; the inner transaction
    // rolls back lower-level surprises.
    if (hasEdges && body.edges) {
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
          if (!targetItem) {
            throw new MarfaError(
              ErrorCode.ITEM_NOT_FOUND,
              `Edge target not found: ${target}`,
            );
          }
        }
      }
    }

    // Declared outside the transaction so the announcement can happen
    // after it commits. `undefined` when the request carried no edges.
    let patchedEdgeChanges: InlineEdgeChanges | undefined;
    const txResult = await storage.runInTransaction(async () => {
      // The version is enforced here for the one arm that never reaches the
      // store: a write carrying only `edges`, or only `retype`, applies over
      // whatever the row has become, so without this the door would collect
      // a required precondition and discard it — worse than not asking at
      // all, because a caller reads a refusal that never came as proof it
      // was current.
      //
      // Inside the transaction and re-reading the row, not against the copy
      // read before it: a check outside is advisory, and any write landing
      // in the window between the two is exactly what the precondition
      // exists to notice.
      //
      // A bare refusal rather than the three-way envelope, deliberately:
      // that envelope hands a resolver two property sets and the fields
      // that collide, and a request carrying no properties has none of
      // them. There is nothing to merge, only a precondition that failed.
      if (!hasProperties && !hasTier && !hasOccurredAt && !hasSourceId) {
        const current = await storage.items.get(id);
        if (current && body.version !== current.version) {
          throw new MarfaError(
            ErrorCode.VERSION_CONFLICT,
            `Version ${String(body.version)} is not the current version ${String(current.version)}`,
            { current_version: current.version },
          );
        }
      }

      // Annotated rather than inferred: the `: item` arm is a plain `Item`,
      // and left to inference the union collapses to it — losing the
      // resolution report the store attaches on the other arm.
      const updated:
        ResolvedItem | ConflictResponse | AncestorUnavailableResponse =
        hasProperties || hasTier || hasOccurredAt || hasSourceId
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
              force_snapshot: body.force_snapshot === true ? true : undefined,
              tier: hasTier ? body.tier : undefined,
              occurred_at: hasOccurredAt ? body.occurred_at : undefined,
              source_id: hasSourceId ? body.source_id : undefined,
            })
          : item;
      if (
        (hasProperties || hasTier || hasOccurredAt || hasSourceId) &&
        "error" in updated
      ) {
        return updated;
      }

      // Through the shared helper rather than a second copy of it.
      //
      // The copy here did the same work — the self-edge refusal and the
      // empty-set case were both already covered, by the pre-validation
      // above and by an empty list being a no-op respectively. What a
      // second copy costs is not correctness today but every change
      // after: adding edge events meant editing two places, and this is
      // the one that would have been missed.
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
    const hydrated = await hydrateEdgesForItem(storage, id);
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

    requireAuth(c);

    const targetItem = await storage.items.get(id);
    if (!targetItem) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    requireTypeAccess(c, targetItem.type, "write");
    // **No live-connection refusal on the named row, because the cascade
    // below already covers it.** `planCascadeDelete` walks post-order and
    // pushes the root itself, so `toDelete` always contains the row named in
    // the URL and the loop inside the transaction asks the refusal of it like
    // any other. A second call here was a duplicate rather than a defense.
    //
    // The check itself stays where the cascade is, and has to: the type gate
    // above ran against the named row alone, and a `parent-of` edge can carry
    // a connection out through a delete of something else entirely.
    // D64: a connector may only destroy what it wrote. Trashing a sibling
    // connection's corpus was the destructive half D63 left open — the
    // property write was refused and the delete was not, which is the
    // stronger harm being the less protected one.
    //
    const snapshots = await storage.runInTransaction(async () => {
      const toDelete = await planCascadeDelete(storage.edges, id);
      const snaps = await Promise.all(
        toDelete.map((delId) => storage.items.get(delId)),
      );
      // **Every row the cascade reaches, not just the one named in the URL.**
      // `parent-of` ships with `cascade_on_delete: "cascade"` and admits any
      // type at either end, so a connection that deletes a row it wrote takes
      // every child with it — including rows a live sibling wrote. Guarding
      // the target alone left the rule one edge away from being void: the
      // direct delete of a sibling's row was refused while the same row went
      // through the cascade, and it published a `deleted` event on the way.
      //
      // Inside the transaction so a refusal rolls the whole plan back rather
      // than leaving a partial cascade, and against the snapshots already
      // read rather than a second round of reads.
      // A `parent-of` edge from any row to a live grant would otherwise
      // carry the grant out through the cascade with no refusal, from a
      // credential that could not write it directly.
      for (const snap of snaps) {
        if (!snap) continue;
        refuseUnlessUninstalled(snap);
      }
      for (const delId of toDelete) {
        await storage.items.delete(delId);
      }
      return snaps;
    });

    // Publish post-commit — a rollback must never leak a `deleted` event.
    for (const snapshot of snapshots) {
      if (snapshot) {
        await publish({
          type: "deleted",
          // The state the store actually wrote, derived per type rather
          // than stated: a type with a bounded lifecycle soft-deletes to
          // `revoked`, so announcing `trashed` told a subscriber about a
          // state the row never entered and no transition can leave.
          item: { ...snapshot, state: softDeleteState(snapshot.type) },
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
  // Nest-mounted here to preserve the original OpenAPI path emission order.
  router.route("/", itemsLifecycleRoutes(storage));
  router.route("/", itemsVersionsRoutes(storage));

  // --- Metadata sub-routes ---

  // GET /items/:id/metadata
  router.openapi(getMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
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

    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

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

    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

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

    // No projection here. This door used to read the metadata row, union the
    // incoming tags into it and refuse over the bound, which was the right
    // shape while the store enforced nothing — but it read in one
    // transaction and wrote in another, so it never bounded anything under
    // concurrency, and it cost an unconditional read on every successful
    // request to duplicate a refusal the store now makes correctly. Both
    // layers produced the same status, the same code and the same message,
    // so nothing on the wire could tell them apart either.
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

    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.

    const body = c.req.valid("json");
    const tags = body.tags;

    // The resulting set is bounded by the store, inside the transaction that
    // computes it. See the sibling door above for why the projection that
    // used to sit here is gone.
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
    // Read before removing. This door used to purge without ever looking at
    // the row, so it could not have known a connection from a note.
    //
    // **Including trashed, and that is the whole of what this door normally
    // sees.** A plain `get` answers `null` for a `trashed` row, so on the
    // ordinary path — trash, then purge — the read came back empty and the
    // announcement below never fired. The two refusals above still worked,
    // because both only have anything to say about a row that is NOT
    // soft-deleted, which is exactly the shape a plain `get` does return.
    // This is the same read `items.purge` runs for its own gate.
    const purgeTarget = await storage.items.getIncludingTrashed(id);
    refuseUnlessUninstalled(purgeTarget);

    // Two doors refuse one operation, and reading only the second one sends
    // you somewhere there is nothing to find.
    //
    // Purging is soft-delete-then-purge, so a caller meets `DELETE
    // /items/{id}` first. For a reserved-namespace row every credential is
    // refused there, by name: "no credential writes system.* items". The
    // row therefore never reaches its soft-deleted state, and
    // this door would answer "Only revoked items can be purged", which is
    // true and reads as an ordering mistake the caller did not make.
    // Somebody following it goes looking for a step they never skipped.
    // Asking the write rule here names the real reason instead, and runs
    // only where the purge was going to be refused anyway.
    //
    // **The state compared is the type's own, never the literal `trashed`.**
    // `softDeleteState` resolves `revoked` for a type with a bounded
    // lifecycle, which `system.connection` has, so a literal comparison sent
    // every revoked connection down this branch to be refused by the write
    // rule that no credential passes. That left the rows uninstall produces
    // permanently unpurgeable. `items.purge` gates on the same derived
    // state, and the two have to agree or one of them refuses what the
    // other admits.
    if (
      purgeTarget &&
      purgeTarget.state !== softDeleteState(purgeTarget.type)
    ) {
      checkTypeAccess(c.get("apiKey"), purgeTarget.type, "write");
    }

    // **No provenance guard here**, and that is a finding rather than an
    // omission: `items.purge` is asked above, and a connector credential's
    // permissions are projected from its manifest and carry no
    // permission at all, so a connector is refused before it reaches the
    // point where provenance would be consulted. A guard here would be
    // unreachable code no test could pin, which is worse than none because it
    // reads as a protection somebody is relying on.
    // `item-write-doors.test.ts` asserts the permission gate instead, so the
    // day this door widens, the case saying a connector cannot purge is
    // the one that reddens.
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
    const cascaded = await storage.runInTransaction(async () => {
      const removed = [
        ...(await storage.edges.deleteBySource(id)),
        ...(await storage.edges.deleteByTarget(id)),
      ];
      await storage.items.purge(id);
      return removed;
    });
    for (const edge of cascaded) {
      await publishEdge({ type: "edge_deleted", edge });
    }
    // The item itself, and the cascade above is what made its absence look
    // covered. A trashed row announced `item.deleted`, which says
    // recoverable; nothing then said the row had gone, and no later event
    // can, because the row is absent rather than changed. A client holding
    // it kept it until a full re-import, and one that was offline across
    // the purge never learned it happened at all. An item with no edges
    // cascaded nothing and so was silent outright.
    //
    // Last, mirroring the ordering a create states in reverse: an edge
    // arrives behind the item it belongs to, so a removal puts the edges
    // first and the row they hang off after them.
    //
    // The snapshot read before the purge, because there is nothing left to
    // read afterwards.
    if (purgeTarget) {
      await publish({ type: "purged", item: purgeTarget });
    }
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
    // corrupts a value that was already correct. This handler used to,
    // and a tag holding a literal percent threw on the second decode and
    // answered 500, while one whose text happened to look like an escape
    // decoded into a different tag and removed nothing, silently.
    const { id, tag } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

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
