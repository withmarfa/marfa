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
import {
  ItemSchema as BaseItemSchema,
  MetadataSchema as BaseMetadataSchema,
} from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";

// Search responses use loose() so the FTS5 ranker's extra columns
// (e.g. relevance internals) don't trip strict validation. The
// underlying field set is the canonical one in _schemas.ts.
const ItemSchema = BaseItemSchema.loose();
const MetadataSchema = BaseMetadataSchema.loose();

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
      library: z.enum(["true", "false", "all"]).optional(),
      /** Comma-separated tag list. Items must have ALL specified tags. */
      tags: z.string().optional(),
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

    const { q, type, state, library, tags, limit, offset, filter } =
      c.req.valid("query");

    // Business logic validation beyond Zod
    if (type && !isValidTypeIdentifier(type)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    if (type) requireTypeAccess(c, type, "read");

    const allowed_types = getTypeFilter(c);

    // Tri-value library filter, matching `/items`. `all` and absent both
    // mean unfiltered; `true` and `false` narrow the scope.
    const libraryFilter: boolean | undefined =
      library === "true" ? true : library === "false" ? false : undefined;

    const tagsFilter = tags
      ? tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : undefined;

    const results = await storage.search.search(q.trim(), {
      tenantId: c.get("apiKey")?.tenant_id,
      type,
      state: state as ItemState | undefined,
      library: libraryFilter,
      tags: tagsFilter,
      filter,
      allowed_types,
      limit,
      offset: offset > 0 ? offset : undefined,
    });

    const apiKey = c.get("apiKey");
    const filtered = results.map((r) => ({
      ...r,
      metadata: filterMetadataForCaller(r.metadata, apiKey),
    }));
    return c.json({ results: filtered }, 200);
  });

  return router;
}
