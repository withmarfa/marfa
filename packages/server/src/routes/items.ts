import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  isValidTimestamp,
  isValidTypeIdentifier,
  getTypeSchema,
  getEdgeTypeSchema,
  validateProperties,
  ITEM_STATES,
  SYSTEM_TYPE_IDS,
  resolveEnforcement,
  isTypeInStrictMode,
  getSourceAllowlist,
  getSourceFilter,
} from "@withmarfa/shared";
import type { ItemState } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireTenantAdmin,
  requireTypeAccess,
  requireEdgePermission,
  getTypeFilter,
} from "../middleware/auth.js";
import { enforceQuota } from "../middleware/quota.js";
import type { Storage, ItemSortField } from "../storage/interface.js";
import { planCascadeDelete } from "../storage/edge-cascade.js";
import { assertEdgesCanBeCreated } from "../storage/edge-constraints.js";
import { publish } from "../pubsub.js";
import { hydrateEdgesForItem, hydrateEdgesForItems } from "./_edges-hydrate.js";
import { applyInlineEdges } from "./_edges-inline.js";
import { hydrateExtensionsForItems } from "./_extensions-hydrate.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import {
  ItemSchema,
  ItemWithMetadataSchema,
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
        "(stamped from the credential) and request `source_id` resolve a " +
        "non-trashed item in the caller's tenant — the request is treated " +
        "as an idempotent re-sync of the upstream entry.",
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

const getItemStatsRoute = createRoute({
  operationId: "getItemStats",
  method: "get",
  path: "/stats",
  tags: ["Items"],
  summary: "Get item counts by state",
  description:
    "Returns a count of items per lifecycle state for the tenant. The counts are scoped to the caller's type permissions, so a credential sees only the types it can read.",
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
    "Returns a paginated list of items in the tenant, narrowed by the query parameters; a `type` filter matches subtypes via inheritance. Lists are lean by default — use `include` to hydrate edges, metadata, or extensions inline and avoid an N+1.",
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
    "Returns a single item with its metadata layer and outbound edges hydrated inline; extensions are not included. An item the caller cannot see returns 404 rather than 403, so the server never leaks existence.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description: "Item with metadata",
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
             *  unique per tenant — server returns 409 `source_id_conflict`
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
    const tenantId = c.get("apiKey")?.tenant_id;

    // Per-tenant items quota. No-op for tenant-less keys (single-tenant +
    // platform admin). Throws 429 quota_exceeded if this create would push
    // the tenant past its items ceiling.
    await enforceQuota(c, storage, "items");

    if (Array.isArray(body.tags) && body.tags.length > 100) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }

    // Schema-enforcement levers: source allow-list, strict-mode, and
    // custom sources. Off by default; enabled per type via tenant config
    // or per-credential override.
    const tenantConfig =
      tenantId && storage.tenants
        ? await storage.tenants.getConfig(tenantId)
        : null;
    const enforcement = resolveEnforcement(tenantConfig, c.get("apiKey"));

    // source is non-forgeable: always stamped from the credential.
    // tier falls back to the credential default when absent.
    // Final fallback is `tier: "library"` — the curated layer is the
    // intended default when neither caller nor credential expresses intent.
    const credential = c.get("apiKey");
    const stampedSource = credential?.source;

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
      getTypeSchema(type, tenantId) !== undefined
    ) {
      const strictResult = validateProperties(type, properties, {
        strict: true,
        tenantId,
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
      if (connectionId) {
        const connection = await storage.items.get(connectionId, tenantId);
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
        if (targets.length > 0) {
          requireEdgePermission(c, edgeType, "write");
        }
      }
    }

    // Natural-key upsert. When both `source` (stamped from the credential)
    // and request `source_id` are present, look up an existing non-trashed
    // row by (source, source_id) within the caller's tenant. If one matches,
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
      const existing = await storage.items.findBySourceId(
        stampedSource,
        body.source_id,
        tenantId,
      );
      if (existing) {
        // If the caller explicitly supplied `id` but it doesn't match the row
        // resolved by (source, source_id), reject rather than silently winning
        // with the existing row's id. A 200 response carrying a different id
        // than the body would be a confusing surprise; signalling the conflict
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
              },
              tenantId,
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
              await applyInlineEdges(storage, updated.id, body.edges, tenantId);
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
          tenantId,
        });
        void storage.audit.log({
          client_ip: c.get("clientIp") ?? null,
          tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
        tenantId,
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
            { tenant_id: tenantId },
          );
          for (const p of proposals) {
            await storage.edges.createRaw(
              {
                source_id: p.source_id,
                target_id: p.target_id,
                edge_type: p.edge_type,
              },
              tenantId,
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
      tenantId,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
    const tenantId = c.get("apiKey")?.tenant_id;
    const allowedTypes = getTypeFilter(c);
    const stats = await storage.items.stats(tenantId, allowedTypes);
    return c.json(stats, 200);
  });

  router.openapi(listItemsRoute, async (c) => {
    requireAuth(c);

    const query = c.req.valid("query");

    const type = query.type;
    if (type && !isValidTypeIdentifier(type) && !type.endsWith(".*")) {
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
    const callerTenantIdForRead = callerKeyForRead?.tenant_id;
    const tenantConfigForRead =
      callerTenantIdForRead && storage.tenants
        ? await storage.tenants.getConfig(callerTenantIdForRead)
        : null;
    const enforcementForRead = resolveEnforcement(
      tenantConfigForRead,
      callerKeyForRead,
    );
    const sourcesFilter =
      typeof type === "string"
        ? (getSourceFilter(enforcementForRead, type) ?? undefined)
        : undefined;

    const result = await storage.items.list({
      tenantId: c.get("apiKey")?.tenant_id,
      type,
      state,
      source: query.source,
      sources: sourcesFilter,
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

    const tid = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const metadata = await storage.metadata.get(id);
    const edges = await hydrateEdgesForItem(storage, id);
    return c.json(
      {
        item: { ...item, edges },
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
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

    const tid = c.get("apiKey")?.tenant_id;

    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    // Natural-key uniqueness check. The `(source, source_id)` tuple is
    // unique per tenant — the same constraint enforced at create time.
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
          tenantId: tid,
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
            { tenant_id: tid },
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
      tenantId: tid,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
    const tid = c.get("apiKey")?.tenant_id;

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
          tenantId: tid,
        });
      }
    }
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
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

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

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
      tenantId: c.get("apiKey")?.tenant_id,
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

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

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
      tenantId: c.get("apiKey")?.tenant_id,
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

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

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
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
      tenantId: c.get("apiKey")?.tenant_id,
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

    requireTenantAdmin(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    // Edges have no FK to items — explicit cleanup required before purge.
    // Fence the edge cleanup to the caller's tenant so a tenant-scoped purge
    // never drops another tenant's edges.
    await storage.edges.deleteBySource(id, undefined, tenantId);
    await storage.edges.deleteByTarget(id, undefined, tenantId);
    await storage.items.purge(id, tenantId);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    const tag = decodeURIComponent(rawTag);
    const metadata = await storage.metadata.removeTag(id, tag);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
      tenantId: c.get("apiKey")?.tenant_id,
    });
    return c.json(
      { metadata: filterMetadataForCaller(metadata, c.get("apiKey")) },
      200,
    );
  });

  return router;
}
