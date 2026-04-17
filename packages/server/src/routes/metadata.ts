import { createRoute, z } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TagWithCountSchema = z.object({
  tag: z.string(),
  count: z.number().int(),
});

const TagListSchema = z.object({
  tags: z.array(TagWithCountSchema),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listTagsRoute = createRoute({
  method: "get",
  path: "/tags",
  tags: ["Metadata"],
  summary: "Enumerate distinct tags in use across visible items",
  security: [{ bearerAuth: [] }],
  request: {},
  responses: {
    200: {
      content: { "application/json": { schema: TagListSchema } },
      description:
        "Distinct tags with usage counts, sorted by count descending then tag ascending. Tenant-scoped; type-permission scoped; trashed items excluded.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

// ---------------------------------------------------------------------------
// Router (mounted at /metadata)
// ---------------------------------------------------------------------------

export function metadataRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listTagsRoute, async (c) => {
    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const allowedTypes = getTypeFilter(c);
    const tags = await storage.metadata.listTags({
      tenantId,
      allowedTypes,
    });
    return c.json({ tags }, 200);
  });

  return router;
}
