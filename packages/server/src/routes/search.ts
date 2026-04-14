import { createRoute, z } from "@hono/zod-openapi";
import {
  MymeError,
  ErrorCode,
  ITEM_STATES,
  isValidTypeIdentifier,
} from "@mymehq/shared";
import type { ItemState } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireTypeAccess,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

const ItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    state: z.string(),
    properties: z.record(z.string(), z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
    timestamp: z.string(),
  })
  .passthrough();

const MetadataSchema = z
  .object({
    tags: z.array(z.string()),
    about: z.array(z.string()),
  })
  .passthrough();

const SearchResultSchema = z.object({
  item: ItemSchema,
  metadata: MetadataSchema,
  relevance_score: z.number(),
  snippet_html: z.string().optional(),
  snippet: z.string().optional(),
});

const searchRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Full-text search across items",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z.string().min(1, "Query parameter 'q' is required"),
      type: z.string().optional(),
      state: z.enum(ITEM_STATES as unknown as [string, ...string[]]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      offset: z.coerce.number().int().min(0).max(10000).optional().default(0),
      filter: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(SearchResultSchema),
          }),
        },
      },
      description: "Search results",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

export function searchRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(searchRoute, async (c) => {
    requireAuth(c);

    const { q, type, state, limit, offset, filter } = c.req.valid("query");

    // Business logic validation beyond Zod
    if (type && !isValidTypeIdentifier(type)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    if (type) requireTypeAccess(c, type, "read");

    const allowed_types = getTypeFilter(c);

    const results = await storage.search.search(q.trim(), {
      tenantId: c.get("apiKey")?.tenant_id,
      type,
      state: state as ItemState | undefined,
      filter,
      allowed_types,
      limit,
      offset: offset > 0 ? offset : undefined,
    });

    return c.json({ results }, 200);
  });

  return router;
}
