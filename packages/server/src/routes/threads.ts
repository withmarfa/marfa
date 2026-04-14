import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode, isValidId } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";
import { ItemSchema } from "./_schemas.js";

// ---------------------------------------------------------------------------
// Schemas (Item lives in _schemas.ts; imported above.)
// ---------------------------------------------------------------------------

const ThreadSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createThreadRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Threads"],
  summary: "Create a new thread",
  security: [{ bearerAuth: [] }],
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ thread: ThreadSchema }),
        },
      },
      description: "Thread created",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const listThreadsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Threads"],
  summary: "List threads with pagination",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(ThreadSchema),
            cursor: z.string().nullable(),
            has_more: z.boolean(),
          }),
        },
      },
      description: "Paginated list of threads",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const getThreadRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Threads"],
  summary: "Get a thread and its items",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            thread: ThreadSchema,
            items: z.array(ItemSchema),
          }),
        },
      },
      description: "Thread with items",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Thread not found",
    },
  },
});

const addItemToThreadRoute = createRoute({
  method: "post",
  path: "/{id}/items",
  tags: ["Threads"],
  summary: "Add an item to a thread",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            item_id: z.string().min(1, "item_id is required"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ item: ItemSchema }),
        },
      },
      description: "Item added to thread",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Thread or item not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Version conflict",
    },
  },
});

const removeItemFromThreadRoute = createRoute({
  method: "delete",
  path: "/{id}/items/{itemId}",
  tags: ["Threads"],
  summary: "Remove an item from a thread",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
      itemId: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ item: ItemSchema }),
        },
      },
      description: "Item removed from thread",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Thread or item not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Version conflict",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function threadRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createThreadRoute, async (c) => {
    requireAuth(c);
    const thread = await storage.threads.create(c.get("apiKey")?.tenant_id);
    await storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "thread.create",
      resource_type: "thread",
      resource_id: thread.id,
    });
    return c.json({ thread }, 201);
  });

  router.openapi(listThreadsRoute, async (c) => {
    requireAuth(c);
    const { limit, cursor } = c.req.valid("query");
    const tid = c.get("apiKey")?.tenant_id;
    const result = await storage.threads.list(limit, cursor ?? undefined, tid);
    return c.json(result, 200);
  });

  router.openapi(getThreadRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid thread ID");
    }
    const tid = c.get("apiKey")?.tenant_id;
    const thread = await storage.threads.get(id, tid);
    if (!thread) {
      throw new MymeError(ErrorCode.THREAD_NOT_FOUND, `Thread ${id} not found`);
    }
    const items = await storage.threads.getItems(id, tid);
    return c.json({ thread, items }, 200);
  });

  router.openapi(addItemToThreadRoute, async (c) => {
    requireAuth(c);
    const { id: threadId } = c.req.valid("param");
    if (!isValidId(threadId)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid thread ID");
    }

    const tid = c.get("apiKey")?.tenant_id;
    const thread = await storage.threads.get(threadId, tid);
    if (!thread) {
      throw new MymeError(
        ErrorCode.THREAD_NOT_FOUND,
        `Thread ${threadId} not found`,
      );
    }

    const { item_id: itemId } = c.req.valid("json");
    if (!isValidId(itemId)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "item_id is required and must be a valid ID",
      );
    }

    const item = await storage.items.get(itemId, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    // Thread membership lives in the `in-thread` edge type now (Wave 2 PR 4).
    // Create or upsert an in-thread edge with source=item, target=thread.
    const existing = await storage.edges.listOutboundOfType(
      itemId,
      "in-thread",
    );
    if (existing.some((e) => e.target_id === threadId)) {
      await storage.threads.touch(threadId);
      return c.json({ item }, 200);
    }
    // Enforce the many-to-one cardinality: member was already in a different
    // thread → remove that edge first so add-to-different-thread works.
    for (const e of existing) {
      await storage.edges.delete(e.id);
    }
    await storage.edges.createRaw(
      { source_id: itemId, target_id: threadId, edge_type: "in-thread" },
      tid,
    );
    await storage.threads.touch(threadId);
    await storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "thread.add_item",
      resource_type: "thread",
      resource_id: threadId,
      details: { item_id: itemId },
    });
    return c.json({ item }, 200);
  });

  router.openapi(removeItemFromThreadRoute, async (c) => {
    requireAuth(c);
    const { id: threadId, itemId } = c.req.valid("param");

    if (!isValidId(threadId)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid thread ID");
    }
    if (!isValidId(itemId)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const tid = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(itemId, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    const edges = await storage.edges.listOutboundOfType(itemId, "in-thread");
    const match = edges.find((e) => e.target_id === threadId);
    if (!match) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Item is not in this thread",
      );
    }
    await storage.edges.delete(match.id);

    await storage.threads.touch(threadId);
    await storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "thread.remove_item",
      resource_type: "thread",
      resource_id: threadId,
      details: { item_id: itemId },
    });
    return c.json({ item }, 200);
  });

  return router;
}
