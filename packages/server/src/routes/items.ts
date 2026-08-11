import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  isValidTimestamp,
  isValidTypeIdentifier,
  isValidTypePattern,
  GLOBAL_TYPE_WILDCARD,
  getTypeSchema,
  getEdgeTypeSchema,
  validateProperties,
  ITEM_STATES,
  SYSTEM_TYPE_IDS,
  resolveEnforcement,
  isTypeInStrictMode,
  getSourceAllowlist,
} from "@withmarfa/shared";
import type { Item, ItemState, Metadata } from "@withmarfa/shared";
import {
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "../storage/merge-properties.js";
import { log } from "../middleware/logger.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireSpaceAdmin,
  requireTypeAccess,
  isOwnConnectionRead,
  itemProvenanceSource,
  requireActivityAttribution,
  requireMirrorProtection,
  checkTypeAccess,
  requireEdgePermission,
  requireRowWritable,
  getTypeFilter,
  INTEGRATION_SOURCE_PREFIX,
} from "../middleware/auth.js";
import { compareProperties } from "./mirror-reconcile.js";
import { reserveQuota } from "../middleware/quota.js";
import type { Storage, ItemSortField } from "../storage/interface.js";
import { planCascadeDelete } from "../storage/edge-cascade.js";
import { assertEdgesCanBeCreated } from "../storage/edge-constraints.js";
import { publish } from "../pubsub.js";
import {
  hydrateEdgesForItem,
  hydrateEdgesForItems,
  hydrateBackrefsForItem,
} from "./_edges-hydrate.js";
import { applyInlineEdges } from "./_edges-inline.js";
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
} from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";
import { itemsLifecycleRoutes } from "./items-lifecycle.js";
import { itemsVersionsRoutes } from "./items-versions.js";

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
  }),
  current: ConflictSnapshotSchema,
  ancestor: ConflictSnapshotSchema,
  conflicting_fields: z.array(z.string()),
  merge_policy: MergePolicySchema,
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
    "Creates an item, validating its properties against the registered type schema before the write; a schema failure rejects the whole item. The server stamps identity, timestamps, version, and the source credential, so passing a `source_id` that already exists for that source upserts the existing item and returns 200 instead of 201.",
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
            timestamp: z.string().optional(),
            source: z.string().optional(),
            source_id: z.string().optional(),
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
        "Item updated via natural-key upsert. Returned when both `source` " +
        "(stamped from the credential) and request `source_id` resolve an " +
        "item in the caller's space — the request is treated as an " +
        "idempotent re-sync of the upstream entry. When the resolved item " +
        "has been trashed the response carries `acknowledged: true` and " +
        "nothing is written: the deletion stands, and the re-sync is " +
        "accepted rather than refused forever.",
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
            "invalid_type",
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
  },
});

const promoteItemRoute = createRoute({
  operationId: "promoteItem",
  method: "post",
  path: "/{id}/promote",
  tags: ["Items"],
  summary: "Promote an integration's copy into your own item",
  description:
    "Mints a new item you own from an integration's mirror of an external record, joined back to the mirror by a `derived-from` edge. The mirror stays a faithful copy the integration keeps re-syncing; the promoted item is yours to edit and is never touched by a re-sync. Only items an integration owns can be promoted.",
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
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "The item is not an integration's copy",
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
    "Reports, field by field, where your item and the integration's mirror now differ. Promotion forks a copy; the mirror keeps re-syncing, so this is how you see what moved upstream since. Accepting a field is an ordinary `PATCH` on your own item, so nothing here writes. Reports against every mirror the item is joined to by `derived-from`.",
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
      description: "The item was not promoted from an integration's copy",
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
  summary: "Get item counts by state",
  description:
    "Returns a count of items per lifecycle state for the space. The counts are scoped to the caller's type permissions, so a credential sees only the types it can read.",
  security: [{ bearerAuth: [] }],
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
  description:
    "Returns a paginated list of items in the space, narrowed by the query parameters; a `type` filter matches subtypes via inheritance. Lists are lean by default — use `include` to hydrate edges, metadata, or extensions inline and avoid an N+1.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z
        .string()
        .optional()
        .describe("Type identifier; matches subtypes via inheritance"),
      state: z.string().optional().describe("Filter by lifecycle state"),
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
          /^(created_at|updated_at|timestamp|properties\.[a-z0-9_]+)$/,
          "sort must be created_at, updated_at, timestamp, or properties.<field>",
        )
        .optional()
        .describe(
          "Field to sort by: a system column (created_at, updated_at, timestamp) or a naturally-orderable custom field via properties.<field> (e.g. properties.due_at). Enum fields like status/priority are not sortable here — their order is semantic, not lexical.",
        ),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      since: z
        .string()
        .optional()
        .describe("Lower bound on the item's effective time (inclusive)"),
      until: z
        .string()
        .optional()
        .describe("Upper bound on the item's effective time (exclusive)"),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Page size, 1–200 (default 50)"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a prior response"),
      include: z
        .string()
        .optional()
        .describe(
          "Comma-separated extras to hydrate inline: edges, metadata, extensions",
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
    "Updates an item's properties, tier, timestamp, edges, or natural key. Properties merge shallowly with existing values while tier and timestamp replace; passing `version` opts into optimistic concurrency and a stale value returns 409 with the conflict context to resolve.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            properties: z.record(z.string(), z.unknown()).optional(),
            version: z.number().int().min(0).optional(),
            force_snapshot: z.boolean().optional(),
            /** Toggle the tier (`library` ↔ `feed`). Independent of the
             *  properties merge path — last-writer-wins. */
            tier: z.enum(["library", "feed"]).optional(),
            /** Override the user-meaningful timestamp (ISO 8601).
             *  Last-writer-wins like `tier`. */
            timestamp: z.string().optional(),
            /** Repoint at a new natural-key identifier under the item's
             *  `source` (the server-stamped value, not the caller's). The
             *  `(source, source_id)` tuple is
             *  unique per space — server returns 409 `source_id_conflict`
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
        "application/json": { schema: ItemWithMetadataSchema },
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
            makeErrorResponseSchema(["source_id_conflict"]),
          ]),
        },
      },
      description:
        "Version conflict (optimistic-concurrency mismatch on `properties`) or `source_id_conflict` (target natural key already in use by another item under the item's `source`).",
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
    "Moves the item to the trashed state, reversible via restore until the retention window expires, after which it is purged permanently. For immediate, irreversible removal use the purge endpoint instead.",
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
    "Hard-deletes the item and its edges, metadata, extensions, and attachment references — irreversible and admin-only. Content-addressed blob bytes are retained if other items still reference them; most clients want the soft-delete endpoint instead.",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Admin required",
    },
  },
});

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
      throw new MarfaError(
        ErrorCode.INVALID_TYPE,
        `Invalid type identifier: ${type}`,
      );
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
    if (body.timestamp && !isValidTimestamp(body.timestamp)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid timestamp");
    }
    if (body.state) {
      if (!(ITEM_STATES as readonly string[]).includes(body.state)) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Invalid state: ${body.state}`,
        );
      }
    }

    requireTypeAccess(c, type, "write");
    const spaceId = c.get("apiKey")?.space_id;

    // The items quota is reserved around the write itself, further down,
    // rather than checked here. A count taken at this point is a check
    // against a number the write is about to change, so N concurrent
    // creates each see room and the space lands at limit + N - 1.

    if (Array.isArray(body.tags) && body.tags.length > 100) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }

    // Schema-enforcement levers: source allow-list, strict-mode, and
    // custom sources. Off by default; enabled per type via space config
    // or per-credential override.
    const spaceConfig =
      spaceId && storage.spaces
        ? await storage.spaces.getConfig(spaceId)
        : null;
    const enforcement = resolveEnforcement(spaceConfig, c.get("apiKey"));

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
      getTypeSchema(type, spaceId) !== undefined
    ) {
      const strictResult = validateProperties(type, properties, {
        strict: true,
        spaceId,
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
    const isSystemTypeWrite = SYSTEM_TYPE_IDS.has(type);
    if (isSystemTypeWrite && body.tier !== undefined) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "tier is not applicable to system.* items",
        { field: "tier" },
      );
    }
    let tierValue: "library" | "feed" | undefined = isSystemTypeWrite
      ? undefined
      : (body.tier ?? credential?.default_tier ?? "library");

    // `system.*` items normally have no tier, but `system.activity` is an
    // exception: when the referenced `system.connection` has
    // `feed_activity === true`, the server stamps `tier: "feed"` so the
    // activity flows into the user's feed surface. Client tier writes
    // remain rejected by the block above; only the server makes this
    // decision, keyed off the per-Connection toggle. Connections without
    // `feed_activity` (default) leave tier undefined as for every other
    // system.* write.
    if (type === "system.activity") {
      const connectionId =
        typeof properties.connection_id === "string"
          ? properties.connection_id
          : undefined;
      // An integration may only speak for itself. Checked before the
      // feed-eligibility lookup below, which would otherwise read a
      // sibling Connection's `feed_activity` toggle and let one
      // integration decide where another's activity surfaces.
      requireActivityAttribution(credential, type, properties);
      if (connectionId) {
        const connection = await storage.items.get(connectionId, spaceId);
        if (
          connection?.type === "system.connection" &&
          connection.properties.feed_activity === true
        ) {
          tierValue = "feed";
        }
      }
    }

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
    // row by (source, source_id) within the caller's space. If one matches,
    // short-circuit to update so `POST /items` is idempotent on re-sync —
    // the contract that lets inbound integration handlers recover from
    // whole-batch retries (createItem-success / cursor-write-fail) without
    // producing duplicates. Returns 200 on this branch (vs 201 on create) so
    // the caller can distinguish the realized effect.
    //
    // Update semantics: properties / tier / timestamp via `ItemStore.update`
    // (shallow-merge); tags via `metadata.set`; edges via `applyInlineEdges`
    // (replace-by-edge-type). Fields only meaningful at create time (id,
    // state, device, capture_*) are ignored — the existing row's id wins.
    if (stampedSource && body.source_id) {
      // Including trashed rows, deliberately. `findBySourceId` hides them,
      // which sent a re-sync of a mirror the user had deleted into the
      // create path, where `create`'s own dedup pre-check — which does not
      // filter state — found the same row and refused with a 409. That 409
      // never clears: the row stays trashed, so every subsequent sync
      // fails the same way and the integration is wedged on one item.
      const existing = await storage.items.findBySourceIdIncludingTrashed(
        stampedSource,
        body.source_id,
        spaceId,
      );
      if (existing?.state === "trashed") {
        // The user deleted this. Reviving it would overturn that decision
        // silently, and refusing forever is the bug being fixed, so the
        // sync is acknowledged and nothing is written or published.
        const metadata = await storage.metadata.get(existing.id);
        return c.json({ item: existing, metadata, acknowledged: true }, 200);
      }
      if (existing) {
        // Authorize the update against the row it lands on, not the body
        // that addressed it. Every gate above ran on `type`, which the
        // caller chose and which this branch never writes — the update
        // takes the resolved row's type as it stands. Naming a type the
        // credential holds write on therefore admitted an edit to a row
        // of any other type, and skipped every gate keyed on the real
        // one, the attribution check included. These are the gates
        // `PATCH /items/{id}` runs; running them here is what makes the
        // two doors agree. The create path below keeps authorizing the
        // claim, because there the claim is the row.
        //
        // Reachable at all because `item_source` fixed provenance to the
        // Connection: a source that rotated with each mint could only
        // ever resolve rows from the credential's own generation.
        const credentialForUpdate = c.get("apiKey");
        requireTypeAccess(c, existing.type, "write");
        requireActivityAttribution(
          credentialForUpdate,
          existing.type,
          existing.properties,
        );
        // Judged on the value the row ends up with. The merge mirrors the
        // shallow property merge the storage layer performs, so a body
        // that leaves `connection_id` alone is not read as claiming an
        // absent one.
        requireActivityAttribution(
          credentialForUpdate,
          existing.type,
          body.properties !== undefined
            ? { ...existing.properties, ...properties }
            : existing.properties,
        );
        requireMirrorProtection(credentialForUpdate, existing);

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

        // An owning integration's re-sync gets faithful-mirror null
        // semantics: the upstream cleared the field, so an explicit null
        // clears the key here too.
        const nullClears =
          existing.source.startsWith("integration:") &&
          credentialForUpdate?.item_source === existing.source;

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
          getTypeSchema(existing.type, spaceId) !== undefined
        ) {
          const merged = mergeUpdateProperties(
            existing.properties,
            resolveIncomingProperties(
              existing.type,
              properties,
              nullClears,
              spaceId,
            ),
            nullClears,
          );
          const validation = validateProperties(existing.type, merged, {
            spaceId,
          });
          if (!validation.success) {
            throw new MarfaError(
              ErrorCode.INVALID_PROPERTIES,
              "Invalid properties",
              { errors: validation.errors },
            );
          }
        }

        const { item: updatedItem, metadata: updatedMetadata } =
          await storage.runInTransaction(async () => {
            const updated = await storage.items.update(
              existing.id,
              {
                ...(body.properties !== undefined && { properties }),
                ...(tierValue !== undefined && { tier: tierValue }),
                ...(body.timestamp !== undefined && {
                  timestamp: body.timestamp,
                }),
                ...(nullClears ? { null_clears: true } : {}),
              },
              spaceId,
            );
            if ("error" in updated) {
              // No version was supplied on a POST — `ItemStore.update` only
              // returns ConflictResponse when a `version` is present in the
              // input. The natural-key upsert path never sets `version`, so
              // this branch should be unreachable. Surface defensively if it
              // ever does.
              throw new MarfaError(
                ErrorCode.VERSION_CONFLICT,
                "Natural-key upsert produced an unexpected version conflict",
                { id: existing.id },
              );
            }

            if (Array.isArray(body.tags)) {
              await storage.metadata.set(updated.id, body.tags);
            }
            if (body.edges) {
              await applyInlineEdges(
                storage,
                updated.id,
                body.edges,
                spaceId,
                (edgeType) => {
                  requireEdgePermission(c, edgeType, "write");
                },
              );
            }

            const meta = await storage.metadata.get(updated.id);
            return { item: updated, metadata: meta };
          });

        const hydratedExisting = await hydrateEdgesForItem(
          storage,
          updatedItem.id,
        );
        const itemWithEdges = { ...updatedItem, edges: hydratedExisting };

        await publish({
          type: "updated",
          item: updatedItem,
          metadata: updatedMetadata,
          spaceId,
        });
        void storage.audit.log({
          client_ip: c.get("clientIp") ?? null,
          space_id: c.get("apiKey")?.space_id ?? null,
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

    const { item, metadata } = await storage.runInTransaction(async () => {
      // The reservation is the first thing in this transaction and holds for
      // the rest of it, so the count it reads includes every create already
      // committed against this space's ceiling.
      await reserveQuota(c, storage, [{ resource: "items", increment: 1 }]);
      const created = await storage.items.create(
        {
          type,
          properties,
          id: body.id,
          state: body.state as ItemState | undefined,
          tier: tierValue,
          timestamp: body.timestamp,
          source: stampedSource,
          source_id: body.source_id,
          device: body.device,
          capture_latitude: body.capture_latitude,
          capture_longitude: body.capture_longitude,
          tags: body.tags,
        },
        spaceId,
      );

      // Atomic edges: for each entry, this item is the source; listed ids
      // are targets. assertEdgesCanBeCreated enforces cardinality / type
      // constraints / cycle rules across the whole batch in grouped queries;
      // failure rolls the entire transaction.
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
            { space_id: spaceId },
          );
          for (const p of proposals) {
            await storage.edges.createRaw(
              {
                source_id: p.source_id,
                target_id: p.target_id,
                edge_type: p.edge_type,
              },
              spaceId,
            );
          }
        }
      }

      const meta = await storage.metadata.get(created.id);
      return { item: created, metadata: meta };
    });

    const hydrated = await hydrateEdgesForItem(storage, item.id);
    const itemWithEdges = { ...item, edges: hydrated };

    await publish({
      type: "created",
      item,
      metadata,
      spaceId,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
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
    const spaceId = credential?.space_id;
    const { id } = c.req.valid("param");

    const mirror = await storage.items.get(id, spaceId);
    if (!mirror) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    if (!mirror.source.startsWith("integration:")) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Only an integration's copy can be promoted; this item is already yours",
        { item_id: id, source: mirror.source },
      );
    }
    requireTypeAccess(c, mirror.type, "write");
    requireEdgePermission(c, "derived-from", "write");

    // The copy is yours: caller-stamped provenance, no natural key (the
    // upstream record's identity stays with the mirror), library tier.
    const promoted = await storage.items.create(
      {
        type: mirror.type,
        properties: { ...mirror.properties },
        tier: "library",
        ...(itemProvenanceSource(credential) !== undefined
          ? { source: itemProvenanceSource(credential) }
          : {}),
      },
      spaceId,
    );
    // derived-from is many-to-many with orphan cascade and the source is
    // a freshly minted node, so the raw write cannot violate cardinality
    // or create a cycle.
    await storage.edges.createRaw(
      {
        source_id: promoted.id,
        target_id: mirror.id,
        edge_type: "derived-from",
        properties: {},
      },
      spaceId,
    );

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: spaceId ?? null,
      key_id: credential?.id,
      action: "item.promote",
      resource_type: "item",
      resource_id: promoted.id,
      details: { mirror_id: mirror.id, type: mirror.type },
    });
    return c.json({ item: promoted }, 201);
  });

  router.openapi(reconcileItemRoute, async (c) => {
    requireAuth(c);
    const credential = c.get("apiKey");
    const spaceId = credential?.space_id;
    const { id } = c.req.valid("param");

    const yours = await storage.items.get(id, spaceId);
    if (!yours) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    requireTypeAccess(c, yours.type, "read");

    const joined = await storage.edges.listFromSource(id, {
      edge_type: "derived-from",
    });
    const mirrors = [];
    for (const edge of joined.data) {
      const mirror = await storage.items.get(edge.target_id, spaceId);
      // A derived-from edge can join any two items; only the ones an
      // integration owns are mirrors, and only those have anything to
      // reconcile against.
      if (!mirror?.source.startsWith(INTEGRATION_SOURCE_PREFIX)) continue;
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
        "This item was not promoted from an integration's copy, so there is nothing to reconcile against",
        { item_id: id },
      );
    }
    return c.json({ mirrors }, 200);
  });

  router.openapi(getItemStatsRoute, async (c) => {
    requireAuth(c);
    const callerKey = c.get("apiKey");
    const spaceId = callerKey?.space_id;
    const allowedTypes = getTypeFilter(c);
    // These counts summarize the listing, so they narrow with it.
    const spaceConfig =
      spaceId && storage.spaces
        ? await storage.spaces.getConfig(spaceId)
        : null;
    const enforcement = resolveEnforcement(spaceConfig, callerKey);
    const stats = await storage.items.stats(
      spaceId,
      allowedTypes,
      enforcement.source_filter,
    );
    return c.json(stats, 200);
  });

  router.openapi(listItemsRoute, async (c) => {
    requireAuth(c);

    const query = c.req.valid("query");

    const type = query.type;
    // The value compiles into a `LIKE` predicate, so it has to clear the
    // pattern grammar rather than a bare "ends with `.*`" shape check —
    // otherwise `%.*` reaches the query as a SQL wildcard. The global `*` is
    // rejected on top: "everything" is `GET /items` with no type at all, and
    // a type filter that matches every type would slip past the per-type
    // enforcement levers keyed off this parameter.
    if (type && (type === GLOBAL_TYPE_WILDCARD || !isValidTypePattern(type))) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    const state = query.state as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    const tagsParam = query.tags;
    const tags = tagsParam
      ? tagsParam.split(",").map((t) => t.trim())
      : undefined;

    // ?edge[X]=Y and ?backref[X]=Y shorthands are AND-composed with any existing filter= param.
    const rawQuery = new URL(c.req.raw.url).searchParams;
    const edgeClauses: string[] = [];
    const shorthandRe = /^(edge|backref)\[([^\]]+)\]$/;
    for (const [key, val] of rawQuery.entries()) {
      // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- using String#match for boolean shape check; no captures needed
      if (key.match(shorthandRe) && val) {
        edgeClauses.push(`${key} eq "${val.replace(/"/g, '\\"')}"`);
      }
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
    const includeSystemTypes = includeSet.has("system");

    // system.* excluded by default; caller opts in via ?include=system or a specific system.* type filter.
    const typeIsSystemTarget =
      typeof type === "string" && type.startsWith("system.");
    const excludeSystemTypes = !includeSystemTypes && !typeIsSystemTarget;

    const callerKeyForRead = c.get("apiKey");
    const callerSpaceIdForRead = callerKeyForRead?.space_id;
    const spaceConfigForRead =
      callerSpaceIdForRead && storage.spaces
        ? await storage.spaces.getConfig(callerSpaceIdForRead)
        : null;
    const enforcementForRead = resolveEnforcement(
      spaceConfigForRead,
      callerKeyForRead,
    );
    const result = await storage.items.list({
      spaceId: c.get("apiKey")?.space_id,
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
      allowed_types: getTypeFilter(c),
      // The query schema's regex already constrains this to a system column or
      // `properties.<field>`; the storage layer re-validates via parseSortField.
      sort: (query.sort as ItemSortField | undefined) ?? undefined,
      direction: query.direction ?? undefined,
      since: query.since,
      until: query.until,
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
    const tid = apiKey?.space_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    // A runtime credential reads its own Connection to resolve its
    // configuration; that one row is admitted without a space-wide
    // `system.connection` grant. See `isOwnConnectionRead`.
    if (!isOwnConnectionRead(apiKey, item)) {
      requireTypeAccess(c, item.type, "read");
    }

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
    // True when the 1-hop neighbour set was capped (more neighbours exist than
    // were hydrated). Distinct from the per-type edge-block `has_more`: several
    // edge types can each sit below their per-type cap while their COMBINED
    // neighbour set exceeds the bound, so this is the only signal that catches
    // that case. Consumers must treat every neighbour-derived view as
    // incomplete when this is set and page the per-type edge/backref endpoints.
    let neighborsTruncated = false;
    // How many neighbours the caller may not read. Omitting them is right —
    // a neighbour outside the caller's scope must never leak — but omitting
    // them *silently* made a partial neighbourhood indistinguishable from a
    // complete one. An app missing an edge scope rendered a ticket with none
    // of its relations and looked correct doing it.
    let neighborsOmitted = 0;
    if (includeNeighbors) {
      // The 1-hop neighborhood: the far-end items of the edge blocks present
      // in this response — outbound targets always, inbound sources when
      // `backrefs` was also requested. Each neighbor is re-authorised through
      // the same space fence + per-type read gate the bulk-get path uses, so a
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
        const found = await storage.items.getMany(ids, tid);
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
    const hasProperties =
      body.properties !== undefined && typeof body.properties === "object";
    const hasEdges =
      body.edges !== undefined &&
      typeof body.edges === "object" &&
      Object.keys(body.edges).length > 0;
    const hasTier = body.tier !== undefined;
    const hasTimestamp = body.timestamp !== undefined;
    const hasSourceId = body.source_id !== undefined;

    if (
      !hasProperties &&
      !hasEdges &&
      !hasTier &&
      !hasTimestamp &&
      !hasSourceId
    ) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "At least one of `properties`, `edges`, `tier`, `timestamp`, or `source_id` is required.",
      );
    }
    if (body.timestamp !== undefined && !isValidTimestamp(body.timestamp)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "timestamp must be an ISO 8601 string",
      );
    }
    if (body.version !== undefined) {
      if (
        typeof body.version !== "number" ||
        !Number.isInteger(body.version) ||
        body.version < 0
      ) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          "version must be a non-negative integer",
        );
      }
    }

    const tid = c.get("apiKey")?.space_id;

    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    // Same rule the create door applies, judged on the resolved row's
    // type rather than on a claim the body never carries here.
    assertTierApplicable(item.type, body.tier);

    // The row has to be this integration's both before and after the
    // update. Before, or an integration could edit a sibling's activity —
    // rewrite its summary, downgrade its severity — without ever naming
    // a connection in the body. After, or it could re-attribute its own
    // row to a sibling once the row exists. The merge below mirrors the
    // shallow property merge the write performs, so a PATCH that leaves
    // `connection_id` alone is judged on the value it will actually end
    // up with rather than on the absence of the field.
    requireActivityAttribution(c.get("apiKey"), item.type, item.properties);
    requireActivityAttribution(
      c.get("apiKey"),
      item.type,
      hasProperties
        ? { ...item.properties, ...(body.properties as object) }
        : item.properties,
    );
    requireMirrorProtection(c.get("apiKey"), item);

    // Natural-key uniqueness check. The `(source, source_id)` tuple is
    // unique per space — the same constraint enforced at create time.
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
        tid,
      );
      if (existing && existing.id !== id) {
        throw new MarfaError(
          ErrorCode.SOURCE_ID_CONFLICT,
          `source_id "${newSourceId}" is already in use under source "${item.source}"`,
          { source: item.source, source_id: newSourceId },
        );
      }
    }

    // Shape-validate the edges payload up-front so the transaction path
    // doesn't have to double-check. Permission gating also runs here
    // (before any write) so a denied request doesn't touch state at all.
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
      const merged = {
        ...item.properties,
        ...body.properties,
      };
      if (getTypeSchema(item.type, tid)) {
        const validation = validateProperties(item.type, merged, {
          spaceId: tid,
        });
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
    // rolls back lower-level surprises on either dialect.
    if (hasEdges && body.edges) {
      for (const [edgeType, targets] of Object.entries(body.edges)) {
        const schema = getEdgeTypeSchema(edgeType, tid);
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
          if (target === id) {
            throw new MarfaError(
              ErrorCode.EDGE_CONSTRAINT_VIOLATION,
              `Edge source and target must be different items`,
              { edge_type: edgeType },
            );
          }
          if (uniqueTargets.has(target)) {
            throw new MarfaError(
              ErrorCode.EDGE_CONSTRAINT_VIOLATION,
              `Duplicate target ${target} in edges.${edgeType}`,
            );
          }
          uniqueTargets.add(target);
          const targetItem = await storage.items.get(target, tid);
          if (!targetItem) {
            throw new MarfaError(
              ErrorCode.ITEM_NOT_FOUND,
              `Edge target not found: ${target}`,
            );
          }
        }
      }
    }

    const txResult = await storage.runInTransaction(async () => {
      const updated =
        hasProperties || hasTier || hasTimestamp || hasSourceId
          ? await storage.items.update(
              id,
              {
                properties: body.properties,
                version: body.version,
                force_snapshot: body.force_snapshot === true ? true : undefined,
                tier: hasTier ? body.tier : undefined,
                timestamp: hasTimestamp ? body.timestamp : undefined,
                source_id: hasSourceId ? body.source_id : undefined,
                // Owning integration re-syncing its mirror: an explicit
                // null clears the key, keeping the copy faithful.
                ...(item.source.startsWith("integration:") &&
                c.get("apiKey")?.item_source === item.source
                  ? { null_clears: true }
                  : {}),
              },
              tid,
            )
          : item;
      if (
        (hasProperties || hasTier || hasTimestamp || hasSourceId) &&
        "error" in updated
      ) {
        return updated;
      }

      // Replace-all per edge type: delete existing edges first so cardinality checks see post-delete state.
      if (hasEdges && body.edges) {
        for (const edgeType of Object.keys(body.edges)) {
          await storage.edges.deleteBySource(id, edgeType, tid);
        }
        const proposals = Object.entries(body.edges).flatMap(
          ([edgeType, targets]) =>
            targets.map((targetId) => ({
              source_id: id,
              target_id: targetId,
              edge_type: edgeType,
            })),
        );
        if (proposals.length > 0) {
          await assertEdgesCanBeCreated(
            storage.edges,
            storage.items,
            proposals,
            { space_id: tid },
          );
          for (const p of proposals) {
            await storage.edges.createRaw(
              {
                source_id: p.source_id,
                target_id: p.target_id,
                edge_type: p.edge_type,
              },
              tid,
            );
          }
        }
      }

      return updated;
    });

    if ("error" in txResult) {
      return c.json(txResult, 409);
    }

    const metadata = await storage.metadata.get(id);
    await publish({
      type: "updated",
      item: txResult,
      metadata,
      spaceId: tid,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.update",
      resource_type: "item",
      resource_id: id,
    });
    const hydrated = await hydrateEdgesForItem(storage, id);
    return c.json(
      {
        item: { ...txResult, edges: hydrated },
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
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
    const tid = c.get("apiKey")?.space_id;

    const targetItem = await storage.items.get(id, tid);
    if (!targetItem) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    requireTypeAccess(c, targetItem.type, "write");

    const snapshots = await storage.runInTransaction(async () => {
      const toDelete = await planCascadeDelete(storage.edges, id, tid);
      const snaps = await Promise.all(
        toDelete.map((delId) => storage.items.get(delId, tid)),
      );
      for (const delId of toDelete) {
        await storage.items.delete(delId, tid);
      }
      return snaps;
    });

    // Publish post-commit — a rollback must never leak a `deleted` event.
    for (const snapshot of snapshots) {
      if (snapshot) {
        await publish({
          type: "deleted",
          item: { ...snapshot, state: "trashed" },
          spaceId: tid,
        });
      }
    }
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
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

    const item = await storage.items.get(id, c.get("apiKey")?.space_id);
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

    const item = await storage.items.get(id, c.get("apiKey")?.space_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.
    requireRowWritable(c.get("apiKey"), item);

    const body = c.req.valid("json");
    const tags = body.tags;

    if (tags.length > 100) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }

    const metadata = await storage.metadata.set(id, tags);
    await publish({
      type: "metadata_changed",
      item,
      metadata,
      spaceId: c.get("apiKey")?.space_id,
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

    const item = await storage.items.get(id, c.get("apiKey")?.space_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.
    requireRowWritable(c.get("apiKey"), item);

    const body = c.req.valid("json");
    const tags = body.tags;

    if (Array.isArray(tags) && tags.length > 100) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }

    const metadata = await storage.metadata.merge(id, tags);

    // Post-merge bounds check (incoming may be small but merge could exceed)
    if (metadata.tags.length > 100) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item (including existing tags)",
      );
    }

    await publish({
      type: "metadata_changed",
      item,
      metadata,
      spaceId: c.get("apiKey")?.space_id,
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

    const item = await storage.items.get(id, c.get("apiKey")?.space_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.
    requireRowWritable(c.get("apiKey"), item);

    const body = c.req.valid("json");
    const tags = body.tags;

    const existingMeta = await storage.metadata.get(id);
    const projectedCount = new Set([...existingMeta.tags, ...tags]).size;
    if (projectedCount > 100) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item (including existing tags)",
      );
    }

    const metadata = await storage.metadata.addTags(id, tags);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.tag",
      resource_type: "item",
      resource_id: id,
      details: { tags },
    });
    await publish({
      type: "metadata_changed",
      item,
      metadata,
      spaceId: c.get("apiKey")?.space_id,
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

    requireSpaceAdmin(c);
    const spaceId = c.get("apiKey")?.space_id;
    // Edges have no FK to items — explicit cleanup required before purge.
    // Fence the edge cleanup to the caller's space so a space-scoped purge
    // never drops another space's edges.
    await storage.edges.deleteBySource(id, undefined, spaceId);
    await storage.edges.deleteByTarget(id, undefined, spaceId);
    await storage.items.purge(id, spaceId);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.purge",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(removeTagRoute, async (c) => {
    const { id, tag: rawTag } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.space_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    // The metadata layer reaches the same row the properties doors
    // guard, so it answers to the same row-level rule.
    requireRowWritable(c.get("apiKey"), item);
    const tag = decodeURIComponent(rawTag);
    const metadata = await storage.metadata.removeTag(id, tag);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.untag",
      resource_type: "item",
      resource_id: id,
      details: { tag },
    });
    await publish({
      type: "metadata_changed",
      item,
      metadata,
      spaceId: c.get("apiKey")?.space_id,
    });
    return c.json(
      { metadata: filterMetadataForCaller(metadata, c.get("apiKey")) },
      200,
    );
  });

  return router;
}
