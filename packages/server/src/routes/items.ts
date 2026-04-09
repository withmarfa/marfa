import { createRoute, z } from "@hono/zod-openapi";
import {
  MymeError,
  ErrorCode,
  isValidId,
  isValidTimestamp,
  isValidTypeIdentifier,
  getTypeSchema,
  validateProperties,
  ITEM_STATES,
} from "@mymehq/shared";
import type { ItemState } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireAdmin,
  requireTypeAccess,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { publish } from "../pubsub.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";

// ---------------------------------------------------------------------------
// Reusable schemas
// ---------------------------------------------------------------------------

const ItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  properties: z.record(z.string(), z.unknown()),
  state: z.string(),
  version: z.number(),
  thread_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  source: z.string().nullable(),
  source_id: z.string().nullable(),
  origin: z.string().nullable(),
  device_id: z.string().nullable(),
  capture_latitude: z.number().nullable(),
  capture_longitude: z.number().nullable(),
  timestamp: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const MetadataSchema = z.object({
  item_id: z.string(),
  tags: z.array(z.string()),
  about: z.array(z.string()),
  extensions: z.record(z.string(), z.unknown()),
});

const ItemWithMetadataSchema = z.object({
  item: ItemSchema,
  metadata: MetadataSchema,
});

const VersionSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  version: z.number(),
  properties: z.record(z.string(), z.unknown()),
  snapshot: z.boolean(),
  created_at: z.string(),
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
            origin: z.string().optional(),
            device_id: z.string().optional(),
            parent_id: z.string().optional(),
            thread_id: z.string().optional(),
            capture_latitude: z.number().optional(),
            capture_longitude: z.number().optional(),
            tags: z.array(z.string()).optional(),
            about: z.array(z.string()).optional(),
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
      parent_id: z.string().optional(),
      thread_id: z.string().optional(),
      tags: z.string().optional(),
      filter: z.string().optional(),
      root_only: z.enum(["true", "false"]).optional(),
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
            parent_id: z.string().nullable().optional(),
            thread_id: z.string().nullable().optional(),
            version: z.number().int().min(0).optional(),
            snapshot: z.boolean().optional(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
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
            state: z.string().min(1),
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
      description: "Item transitioned",
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
            about: z.array(z.string()).optional().default([]),
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
            about: z.array(z.string()).optional(),
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
            tags: z.array(z.string()).min(1, "tags must be a non-empty array of strings"),
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
    if (body.parent_id && !isValidId(body.parent_id)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid parent_id");
    }
    if (body.thread_id && !isValidId(body.thread_id)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid thread_id");
    }
    if (body.state) {
      const typeSchema = getTypeSchema(type);
      const validStates = typeSchema
        ? (typeSchema.states as string[])
        : (ITEM_STATES as readonly string[]);
      if (!validStates.includes(body.state)) {
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
    if (Array.isArray(body.about) && body.about.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 about references per item",
      );
    }

    const item = await storage.items.create(
      {
        type,
        properties,
        id: body.id as string | undefined,
        state: body.state as ItemState | undefined,
        timestamp: body.timestamp as string | undefined,
        source: body.source as string | undefined,
        source_id: body.source_id as string | undefined,
        origin: body.origin as string | undefined,
        device_id: body.device_id as string | undefined,
        parent_id: body.parent_id as string | undefined,
        thread_id: body.thread_id as string | undefined,
        capture_latitude: body.capture_latitude as number | undefined,
        capture_longitude: body.capture_longitude as number | undefined,
        tags: body.tags as string[] | undefined,
        about: body.about as string[] | undefined,
      },
      tenantId,
    );

    const metadata = await storage.metadata.get(item.id);
    await publish({ type: "created", item, metadata, tenantId });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.create",
      resource_type: "item",
      resource_id: item.id,
      details: { type: item.type },
    });
    return c.json({ item, metadata }, 201);
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

    const filter = query.filter ?? undefined;
    const rootOnly = query.root_only === "true";
    const includeMetadata = query.include === "metadata";

    const result = await storage.items.list({
      tenantId: c.get("apiKey")?.tenant_id,
      type,
      state,
      source: query.source,
      parent_id: query.parent_id,
      thread_id: query.thread_id,
      root_only: rootOnly || undefined,
      tags,
      filter,
      allowed_types: getTypeFilter(c),
      sort:
        (query.sort as
          | "created_at"
          | "updated_at"
          | "timestamp"
          | undefined) ?? undefined,
      direction:
        (query.direction as "asc" | "desc" | undefined) ?? undefined,
      since: query.since,
      until: query.until,
      limit: query.limit,
      cursor: query.cursor,
    });

    if (includeMetadata) {
      const ids = result.data.map((item) => item.id);
      const metadataList = await storage.metadata.getMany(ids);
      const metadataMap = new Map(metadataList.map((m) => [m.item_id, m]));
      return c.json(
        {
          data: result.data.map((item) => ({
            item,
            metadata: metadataMap.get(item.id) ?? {
              item_id: item.id,
              tags: [],
              about: [],
              extensions: {},
            },
          })),
          cursor: result.cursor,
          has_more: result.has_more,
        },
        200,
      );
    }

    return c.json(result, 200);
  });

  // GET /items/:id — get single
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
    return c.json({ item, metadata }, 200);
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
    const hasParentId = "parent_id" in body;
    const hasThreadId = "thread_id" in body;

    if (!hasProperties && !hasParentId && !hasThreadId) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "At least one of properties, parent_id, or thread_id is required",
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

    // Validate parent_id if provided
    if (hasParentId && body.parent_id !== null) {
      if (typeof body.parent_id !== "string" || !isValidId(body.parent_id)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "parent_id must be a valid ID or null",
        );
      }
      if (body.parent_id === id) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "An item cannot be its own parent",
        );
      }
    }

    // Validate thread_id if provided
    if (hasThreadId && body.thread_id !== null) {
      if (typeof body.thread_id !== "string" || !isValidId(body.thread_id)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "thread_id must be a valid ID or null",
        );
      }
    }

    const tid = c.get("apiKey")?.tenant_id;

    // Verify thread exists if setting a non-null thread_id
    if (hasThreadId && body.thread_id !== null) {
      const thread = await storage.threads.get(body.thread_id as string, tid);
      if (!thread) {
        throw new MymeError(
          ErrorCode.THREAD_NOT_FOUND,
          `Thread ${body.thread_id as string} not found`,
        );
      }
    }

    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    // Cycle detection: walk up from proposed parent to ensure this item isn't an ancestor
    if (hasParentId && body.parent_id !== null) {
      let current = body.parent_id as string;
      const visited = new Set<string>([id]);
      while (current) {
        if (visited.has(current)) {
          throw new MymeError(
            ErrorCode.VALIDATION_ERROR,
            "Setting this parent_id would create a cycle",
          );
        }
        visited.add(current);
        const ancestor = await storage.items.get(current, tid);
        if (!ancestor?.parent_id) break;
        current = ancestor.parent_id;
      }
    }

    if (hasProperties) {
      const merged = {
        ...item.properties,
        ...(body.properties as Record<string, unknown>),
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

    const result = await storage.items.update(
      id,
      {
        properties: hasProperties
          ? (body.properties as Record<string, unknown>)
          : undefined,
        parent_id: hasParentId ? (body.parent_id as string | null) : undefined,
        thread_id: hasThreadId ? (body.thread_id as string | null) : undefined,
        version: body.version as number,
        snapshot: body.snapshot === true ? true : undefined,
      },
      tid,
    );

    // Touch thread updated_at when thread assignment changes
    if (hasThreadId && body.thread_id !== null) {
      await storage.threads.touch(body.thread_id as string);
    }

    if ("error" in result) {
      return c.json(result, 409);
    }

    const metadata = await storage.metadata.get(id);
    await publish({ type: "updated", item: result, metadata, tenantId: tid });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.update",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ item: result, metadata }, 200);
  });

  // DELETE /items/:id — soft delete
  router.openapi(deleteItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    const tid = c.get("apiKey")?.tenant_id;
    const existing = await storage.items.get(id, tid);
    await storage.items.delete(id, tid);
    if (existing) {
      await publish({
        type: "deleted",
        item: { ...existing, state: "trashed" as ItemState },
        tenantId: tid,
      });
    }
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
    if (!state || typeof state !== "string") {
      throw new MymeError(
        ErrorCode.INVALID_TRANSITION,
        `Invalid state: ${String(state)}`,
      );
    }

    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tenantId);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    requireTypeAccess(c, item.type, "write");
    const updated = await storage.items.transition(
      id,
      state as ItemState,
      tenantId,
    );
    const metadata = await storage.metadata.get(id);
    await publish({ type: "transitioned", item: updated, metadata, tenantId });
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
    const about = body.about;

    if (tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }
    if (about.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 about references per item",
      );
    }

    const metadata = await storage.metadata.set(id, tags, about);
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
    const about = body.about;

    // Pre-merge bounds check on incoming arrays
    if (Array.isArray(tags) && tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }
    if (Array.isArray(about) && about.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 about references per item",
      );
    }

    const metadata = await storage.metadata.merge(id, tags, about);

    // Post-merge bounds check (incoming may be small but merge could exceed)
    if (metadata.tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item (including existing tags)",
      );
    }
    if (metadata.about.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 about references per item (including existing)",
      );
    }

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
    return c.json({ metadata }, 200);
  });

  return router;
}
