import { createRoute, z } from "@hono/zod-openapi";
import {
  MymeError,
  ErrorCode,
  isValidId,
  isValidTimestamp,
  isValidTypeIdentifier,
  getTypeSchema,
  getEdgeTypeSchema,
  validateProperties,
  ITEM_STATES,
} from "@mymehq/shared";
import type { ItemState } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireAdmin,
  requireTypeAccess,
  requireEdgePermission,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { planCascadeDelete } from "../storage/edge-cascade.js";
import { assertEdgeCanBeCreated } from "../storage/edge-constraints.js";
import { publish } from "../pubsub.js";
import { hydrateEdgesForItem, hydrateEdgesForItems } from "./_edges-hydrate.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import {
  ItemSchema,
  ItemWithMetadataSchema,
  MetadataSchema,
} from "./_schemas.js";

// ---------------------------------------------------------------------------
// Reusable schemas (Item / Metadata / ItemWithMetadata live in _schemas.ts;
// imported above. The conflict-response and version schemas are local to
// items.ts since no other route uses them.)
// ---------------------------------------------------------------------------

const ConflictSnapshotSchema = z.object({
  version: z.number(),
  properties: z.record(z.string(), z.unknown()),
});

const ConflictResponseSchema = z.object({
  error: z.object({
    code: z.literal("version_conflict"),
    status: z.literal(409),
  }),
  current: ConflictSnapshotSchema,
  ancestor: ConflictSnapshotSchema,
  conflicting_fields: z.array(z.string()),
});

const VersionSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  version: z.number(),
  properties: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  device: z.string().optional(),
});

const IdParam = z.object({
  id: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createItemRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Items"],
  summary: "Create an item",
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
            origin: z.enum(["user", "ai", "worker"]).optional(),
            library: z.boolean().optional(),
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
    201: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description: "Item created",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
  },
});

const getItemStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Items"],
  summary: "Get item counts by state",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const listItemsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Items"],
  summary: "List items with filtering and pagination",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z.string().optional(),
      state: z.string().optional(),
      source: z.string().optional(),
      library: z.enum(["true", "false", "all"]).optional(),
      tags: z.string().optional(),
      filter: z.string().optional(),
      sort: z.enum(["created_at", "updated_at", "timestamp"]).optional(),
      direction: z.enum(["asc", "desc"]).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
      cursor: z.string().optional(),
      include: z.string().optional(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const getItemRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Items"],
  summary: "Get a single item",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

const updateItemRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Items"],
  summary: "Update an item with conflict detection",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            properties: z.record(z.string(), z.unknown()).optional(),
            version: z.number().int().min(0).optional(),
            snapshot: z.boolean().optional(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
    409: {
      content: { "application/json": { schema: ConflictResponseSchema } },
      description: "Version conflict",
    },
  },
});

const deleteItemRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Items"],
  summary: "Soft delete (trash) an item",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const restoreItemRoute = createRoute({
  method: "post",
  path: "/{id}/restore",
  tags: ["Items"],
  summary: "Restore a trashed item",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description: "Item restored",
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

const transitionItemRoute = createRoute({
  method: "post",
  path: "/{id}/transition",
  tags: ["Items"],
  summary: "Transition item state",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            state: z.enum(["active", "archived", "trashed"]),
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
      description: "Item state changed",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid transition",
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

const listVersionsRoute = createRoute({
  method: "get",
  path: "/{id}/versions",
  tags: ["Items"],
  summary: "List version history for an item",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            versions: z.array(VersionSchema),
          }),
        },
      },
      description: "Version history",
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

const getMetadataRoute = createRoute({
  method: "get",
  path: "/{id}/metadata",
  tags: ["Items"],
  summary: "Get item metadata",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

const putMetadataRoute = createRoute({
  method: "put",
  path: "/{id}/metadata",
  tags: ["Items"],
  summary: "Replace item metadata",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
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

const patchMetadataRoute = createRoute({
  method: "patch",
  path: "/{id}/metadata",
  tags: ["Items"],
  summary: "Merge metadata (set-union)",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
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

const addTagsRoute = createRoute({
  method: "post",
  path: "/{id}/tags",
  tags: ["Items"],
  summary: "Add tags to an item",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
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

const removeTagRoute = createRoute({
  method: "delete",
  path: "/{id}/tags/{tag}",
  tags: ["Items"],
  summary: "Remove a tag from an item",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
      tag: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

const purgeItemRoute = createRoute({
  method: "delete",
  path: "/{id}/purge",
  tags: ["Items"],
  summary: "Permanently delete a trashed item (admin only)",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
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
      throw new MymeError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        "type is required",
        {
          field: "type",
        },
      );
    }
    if (!isValidTypeIdentifier(type)) {
      throw new MymeError(
        ErrorCode.INVALID_TYPE,
        `Invalid type identifier: ${type}`,
      );
    }

    const properties = body.properties ?? {};
    if (typeof properties !== "object") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "properties must be an object",
      );
    }

    if (body.id && !isValidId(body.id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    if (body.timestamp && !isValidTimestamp(body.timestamp)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid timestamp");
    }
    if (body.state) {
      if (!(ITEM_STATES as readonly string[]).includes(body.state)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Invalid state: ${body.state}`,
        );
      }
    }

    requireTypeAccess(c, type, "write");
    const tenantId = c.get("apiKey")?.tenant_id;

    if (Array.isArray(body.tags) && body.tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }

    // source is non-forgeable: always stamped from the credential.
    // origin and library fall back to credential defaults when absent.
    const credential = c.get("apiKey");
    const stampedSource = credential?.source;
    const stampedOrigin = body.origin ?? credential?.default_origin;
    const libraryValue = body.library ?? credential?.default_library ?? false;

    // Validate edges payload up-front (shape only) so the write path doesn't
    // have to double-check. Per-constraint validation runs inside the
    // transaction against the just-created item.
    if (body.edges) {
      for (const [edgeType, targets] of Object.entries(body.edges)) {
        if (!Array.isArray(targets)) {
          throw new MymeError(
            ErrorCode.VALIDATION_ERROR,
            `edges.${edgeType} must be an array of item ids`,
          );
        }
        for (const target of targets) {
          if (!isValidId(target)) {
            throw new MymeError(
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

    const { item, metadata } = await storage.runInTransaction(async () => {
      const created = await storage.items.create(
        {
          type,
          properties,
          id: body.id,
          state: body.state as ItemState | undefined,
          library: libraryValue,
          timestamp: body.timestamp,
          source: stampedSource,
          source_id: body.source_id,
          origin: stampedOrigin,
          device: body.device,
          capture_latitude: body.capture_latitude,
          capture_longitude: body.capture_longitude,
          tags: body.tags,
        },
        tenantId,
      );

      // Atomic edges: for each entry, this item is the source; listed ids
      // are targets. assertEdgeCanBeCreated enforces cardinality / type
      // constraints / cycle rules; failure rolls the entire transaction.
      if (body.edges) {
        for (const [edgeType, targets] of Object.entries(body.edges)) {
          for (const targetId of targets) {
            await assertEdgeCanBeCreated(storage.edges, storage.items, {
              source_id: created.id,
              target_id: targetId,
              edge_type: edgeType,
              tenant_id: tenantId,
            });
            await storage.edges.createRaw(
              {
                source_id: created.id,
                target_id: targetId,
                edge_type: edgeType,
              },
              tenantId,
            );
          }
        }
      }

      const meta = await storage.metadata.get(created.id);
      return { item: created, metadata: meta };
    });

    // Hydrate edges onto the response (always on single-item write/read).
    const hydrated = await hydrateEdgesForItem(storage, item.id);
    const itemWithEdges = { ...item, edges: hydrated };

    await publish({ type: "created", item, metadata, tenantId });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.create",
      resource_type: "item",
      resource_id: item.id,
      details: { type: item.type },
    });
    return c.json({ item: itemWithEdges, metadata }, 201);
  });

  // GET /items/stats — item counts grouped by state
  router.openapi(getItemStatsRoute, async (c) => {
    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const allowedTypes = getTypeFilter(c);
    const stats = await storage.items.stats(tenantId, allowedTypes);
    return c.json(stats, 200);
  });

  // GET /items — list
  router.openapi(listItemsRoute, async (c) => {
    requireAuth(c);

    const query = c.req.valid("query");

    const type = query.type;
    if (type && !isValidTypeIdentifier(type) && !type.endsWith(".*")) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    const state = query.state as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    const tagsParam = query.tags;
    const tags = tagsParam
      ? tagsParam.split(",").map((t) => t.trim())
      : undefined;

    // URL shorthand: `?edge[X]=Y` (outbound) and `?backref[X]=Y` (inbound)
    // get translated into filter clauses and AND-composed with any existing
    // `filter=` param. Multiple shorthand params are joined with AND — the
    // parser rejects mixing AND and OR in a single expression, so any existing
    // OR in `filter=` disqualifies the shorthand; document as a known limit.
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
    // Read library from the raw query string. zod-openapi's query
    // validation occasionally drops boolean-as-string enums (a quirk
    // independent of the schema being declared correctly); the raw
    // query lookup is the reliable source.
    // V0 spec: the default query scope is unfiltered (library + ambient).
    //   ?library=true  -> library only
    //   ?library=false -> ambient only
    //   ?library=all or absent -> no filter
    // See Myme Reference §Library axis.
    const rawLibrary = c.req.query("library");
    const library: boolean | undefined =
      rawLibrary === "true" ? true : rawLibrary === "false" ? false : undefined;
    // `include` accepts a comma-separated list. "metadata" adds the sidecar
    // object per item; "edges" hydrates outbound edges inline (opt-in — list
    // reads skip edge hydration by default to avoid an N+1 on large lists).
    const includeSet = new Set(
      (query.include ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    const includeMetadata = includeSet.has("metadata");
    const includeEdges = includeSet.has("edges");

    const result = await storage.items.list({
      tenantId: c.get("apiKey")?.tenant_id,
      type,
      state,
      source: query.source,
      library,
      tags,
      filter,
      allowed_types: getTypeFilter(c),
      sort: query.sort ?? undefined,
      direction: query.direction ?? undefined,
      since: query.since,
      until: query.until,
      limit: query.limit,
      cursor: query.cursor,
    });

    const ids = result.data.map((item) => item.id);
    const edgesMap = includeEdges
      ? await hydrateEdgesForItems(storage, ids)
      : null;
    const decorate = (item: (typeof result.data)[number]) =>
      edgesMap ? { ...item, edges: edgesMap.get(item.id) ?? {} } : item;

    if (includeMetadata) {
      const metadataList = await storage.metadata.getMany(ids);
      const metadataMap = new Map(metadataList.map((m) => [m.item_id, m]));
      return c.json(
        {
          data: result.data.map((item) => ({
            item: decorate(item),
            metadata: metadataMap.get(item.id) ?? {
              item_id: item.id,
              tags: [],
              extensions: {},
            },
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

  // GET /items/:id — get single. Always hydrates outbound edges (capped per
  // type) so callers see relationships without a second round-trip.
  router.openapi(getItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const tid = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const metadata = await storage.metadata.get(id);
    const edges = await hydrateEdgesForItem(storage, id);
    return c.json({ item: { ...item, edges }, metadata }, 200);
  });

  // PATCH /items/:id — update with conflict detection
  router.openapi(updateItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const hasProperties =
      body.properties !== undefined && typeof body.properties === "object";
    const hasEdges =
      body.edges !== undefined &&
      typeof body.edges === "object" &&
      Object.keys(body.edges).length > 0;

    if (!hasProperties && !hasEdges) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "At least one of `properties` or `edges` is required. Relationship changes flow through the `edges` payload or direct /edges endpoints.",
      );
    }
    if (body.version !== undefined) {
      if (
        typeof body.version !== "number" ||
        !Number.isInteger(body.version) ||
        body.version < 0
      ) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "version must be a non-negative integer",
        );
      }
    }

    const tid = c.get("apiKey")?.tenant_id;

    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    // Shape-validate the edges payload up-front so the transaction path
    // doesn't have to double-check. Permission gating also runs here
    // (before any write) so a denied request doesn't touch state at all.
    if (hasEdges && body.edges) {
      for (const [edgeType, targets] of Object.entries(body.edges)) {
        if (!Array.isArray(targets)) {
          throw new MymeError(
            ErrorCode.VALIDATION_ERROR,
            `edges.${edgeType} must be an array of item ids`,
          );
        }
        for (const target of targets) {
          if (!isValidId(target)) {
            throw new MymeError(
              ErrorCode.INVALID_ID,
              `Invalid target id in edges.${edgeType}`,
            );
          }
        }
        // Dual gate: item-type write is already enforced above;
        // edge-type write applies whether we're adding targets or
        // wiping the type entirely (the action is mutating the set).
        requireEdgePermission(c, edgeType, "write");
      }
    }

    if (body.properties) {
      const merged = {
        ...item.properties,
        ...body.properties,
      };
      if (getTypeSchema(item.type)) {
        const validation = validateProperties(item.type, merged);
        if (!validation.success) {
          throw new MymeError(
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
    // (after-delete) cardinality stays within bounds. Runs before the
    // delete-and-create pass so sqlite (whose runInTransaction can't
    // rollback async work) doesn't leave a half-applied state on a
    // validation failure. pg's runInTransaction rollback still kicks
    // in for lower-level surprises.
    if (hasEdges && body.edges) {
      for (const [edgeType, targets] of Object.entries(body.edges)) {
        const schema = getEdgeTypeSchema(edgeType);
        if (!schema) {
          throw new MymeError(
            ErrorCode.EDGE_TYPE_NOT_FOUND,
            `Unknown edge type: ${edgeType}`,
          );
        }
        // Detect duplicate target ids in the payload (same edge would
        // fail existsExact after the first insert).
        const uniqueTargets = new Set<string>();
        for (const target of targets) {
          if (target === id) {
            throw new MymeError(
              ErrorCode.EDGE_CONSTRAINT_VIOLATION,
              `Edge source and target must be different items`,
              { edge_type: edgeType },
            );
          }
          if (uniqueTargets.has(target)) {
            throw new MymeError(
              ErrorCode.EDGE_CONSTRAINT_VIOLATION,
              `Duplicate target ${target} in edges.${edgeType}`,
            );
          }
          uniqueTargets.add(target);
          const targetItem = await storage.items.get(target, tid);
          if (!targetItem) {
            throw new MymeError(
              ErrorCode.ITEM_NOT_FOUND,
              `Edge target not found: ${target}`,
            );
          }
        }
      }
    }

    const txResult = await storage.runInTransaction(async () => {
      const updated = hasProperties
        ? await storage.items.update(
            id,
            {
              properties: body.properties,
              version: body.version,
              snapshot: body.snapshot === true ? true : undefined,
            },
            tid,
          )
        : item;
      if (hasProperties && "error" in updated) {
        return updated;
      }

      // Replace-all-for-specified-types: delete every existing outbound
      // edge of the listed edge_type, then create fresh ones. Validation
      // already ran above so this pass should not see constraint errors
      // outside of concurrent mutation, which the pg transaction rolls
      // back naturally.
      if (hasEdges && body.edges) {
        for (const [edgeType, targets] of Object.entries(body.edges)) {
          await storage.edges.deleteBySource(id, edgeType);
          for (const targetId of targets) {
            await assertEdgeCanBeCreated(storage.edges, storage.items, {
              source_id: id,
              target_id: targetId,
              edge_type: edgeType,
              tenant_id: tid,
            });
            await storage.edges.createRaw(
              {
                source_id: id,
                target_id: targetId,
                edge_type: edgeType,
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
      key_id: c.get("apiKey")?.id,
      action: "item.update",
      resource_type: "item",
      resource_id: id,
    });
    const hydrated = await hydrateEdgesForItem(storage, id);
    return c.json({ item: { ...txResult, edges: hydrated }, metadata }, 200);
  });

  // DELETE /items/:id — soft delete
  // Cascade-on-delete semantics: outbound edges with cascade_on_delete=cascade
  // (parent-of in the V0 core set) recursively soft-delete their targets;
  // block edges (none in V0 core set, but custom types may use them) reject
  // the delete outright. Orphan is the no-op default.
  router.openapi(deleteItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    const tid = c.get("apiKey")?.tenant_id;

    await storage.runInTransaction(async () => {
      // Walk the edge graph to plan the cascade + reject block-edges.
      const toDelete = await planCascadeDelete(storage.edges, id);

      // Fetch snapshots before deletion for event payloads.
      const snapshots = await Promise.all(
        toDelete.map((delId) => storage.items.get(delId, tid)),
      );

      for (const delId of toDelete) {
        await storage.items.delete(delId, tid);
      }

      // Publish one deleted event per item (post-order: leaves first).
      for (const snapshot of snapshots) {
        if (snapshot) {
          await publish({
            type: "deleted",
            item: { ...snapshot, state: "trashed" as ItemState },
            tenantId: tid,
          });
        }
      }
    });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.delete",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  // POST /items/:id/restore
  router.openapi(restoreItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const restored = await storage.items.restore(id, tenantId);
    requireTypeAccess(c, restored.type, "write");
    const metadata = await storage.metadata.get(id);
    await publish({ type: "restored", item: restored, metadata, tenantId });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.restore",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ item: restored, metadata }, 200);
  });

  // POST /items/:id/transition
  router.openapi(transitionItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const state = body.state;
    // body.state is constrained to the lifecycle enum by the route Zod;
    // typeof / truthiness check would be unreachable.

    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tenantId);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    requireTypeAccess(c, item.type, "write");
    const updated = await storage.items.transition(id, state, tenantId);
    const metadata = await storage.metadata.get(id);
    await publish({ type: "state_changed", item: updated, metadata, tenantId });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.transition",
      resource_type: "item",
      resource_id: id,
      details: { from_state: item.state, to_state: state },
    });
    return c.json({ item: updated, metadata }, 200);
  });

  // GET /items/:id/versions
  router.openapi(listVersionsRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const versions = await storage.versions.list(id);
    return c.json({ versions }, 200);
  });

  // --- Metadata sub-routes ---

  // GET /items/:id/metadata
  router.openapi(getMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    return c.json({ metadata: await storage.metadata.get(id) }, 200);
  });

  // PUT /items/:id/metadata — full replacement
  router.openapi(putMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = c.req.valid("json");
    const tags = body.tags;

    if (tags.length > 100) {
      throw new MymeError(
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
    return c.json({ metadata }, 200);
  });

  // PATCH /items/:id/metadata — set-union merge
  router.openapi(patchMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = c.req.valid("json");
    const tags = body.tags;

    // Pre-merge bounds check on incoming arrays
    if (Array.isArray(tags) && tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }

    const metadata = await storage.metadata.merge(id, tags);

    // Post-merge bounds check (incoming may be small but merge could exceed)
    if (metadata.tags.length > 100) {
      throw new MymeError(
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
    return c.json({ metadata }, 200);
  });

  // POST /items/:id/tags
  router.openapi(addTagsRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = c.req.valid("json");
    const tags = body.tags;

    const metadata = await storage.metadata.addTags(id, tags);
    if (metadata.tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item (including existing tags)",
      );
    }
    void storage.audit.log({
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
    return c.json({ metadata }, 200);
  });

  // DELETE /items/:id/purge — permanently delete a trashed item (admin only)
  router.openapi(purgeItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAdmin(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    // Edges no longer carry a FK to items (thread-target compat window) so
    // cascade cleanup must happen explicitly before the item row goes.
    await storage.edges.deleteBySource(id);
    await storage.edges.deleteByTarget(id);
    await storage.items.purge(id, tenantId);
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.purge",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  // DELETE /items/:id/tags/:tag
  router.openapi(removeTagRoute, async (c) => {
    const { id, tag: rawTag } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    const tag = decodeURIComponent(rawTag);
    const metadata = await storage.metadata.removeTag(id, tag);
    void storage.audit.log({
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
    return c.json({ metadata }, 200);
  });

  return router;
}
