import { createRoute, z } from "@hono/zod-openapi";
import { pageOf } from "./_schemas.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  getTypeFilter,
  readsSomeType,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TagWithCountSchema = z
  .object({
    tag: z.string(),
    count: z.number().int(),
  })
  .openapi("TagCount");

const TagListSchema = pageOf(TagWithCountSchema, "TagCountPage");

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listTagsRoute = createRoute({
  operationId: "listTags",
  method: "get",
  path: "/tags",
  tags: ["Metadata"],
  summary: "List distinct tags in use",
  description:
    "Returns every distinct tag in use across items the caller can read, each with a usage count, sorted by count descending then tag ascending. Scoped to the caller's type permissions and to the active state, which is the selection `GET /items` answers, so every tag listed here opens to rows.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {},
  responses: {
    200: {
      content: { "application/json": { schema: TagListSchema } },
      description:
        "Distinct tags with usage counts, sorted by count descending then tag ascending. Type-permission scoped, and counted over the active state, as the listing is.",
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

// ---------------------------------------------------------------------------
// Router (mounted at /metadata)
// ---------------------------------------------------------------------------

export function metadataRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listTagsRoute, async (c) => {
    requireAuth(c);
    const { allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(c);
    const tags = await storage.metadata.listTags({
      allowedTypes,
      excludedTypes,
    });
    return c.json({ data: tags, next_cursor: null }, 200);
  });

  return router;
}
