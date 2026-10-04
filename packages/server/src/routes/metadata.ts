import { createRoute, z } from "@hono/zod-openapi";
import { resolveEnforcement } from "@withmarfa/shared";
import { pageOf } from "./_schemas.js";
import { readInstanceConfig } from "../storage/instance-config.js";
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
  summary: "List tags",
  description:
    "Returns every tag in use on the active items you can read, with the number of items that carry it. Sorted by count, highest first, then by tag.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {},
  responses: {
    200: {
      content: { "application/json": { schema: TagListSchema } },
      description: "Returns each tag and its count.",
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
        "- `type_not_permitted`: your credential reaches no type. If it reaches some types, the list covers only those.",
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
    const enforcement = resolveEnforcement(
      await readInstanceConfig(storage.settings),
      c.get("apiKey"),
    );
    const tags = await storage.metadata.listTags({
      allowedTypes,
      excludedTypes,
      source_filter: enforcement.source_filter,
    });
    return c.json({ data: tags, next_cursor: null }, 200);
  });

  return router;
}
