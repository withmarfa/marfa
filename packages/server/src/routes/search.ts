import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  ITEM_STATES,
  isValidTypeIdentifier,
  resolveEnforcement,
  getSourceFilter,
} from "@withmarfa/shared";
import type { ItemState } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireTypeAccess,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
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
});

const searchRoute = createRoute({
  operationId: "searchItems",
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Search items",
  description:
    "Full-text search across the tenant's items, indexing textual properties and tags, ranked by relevance with a configurable recency boost. Accepts the same filters as `GET /items` and uses `limit` / `offset` paging; absolute scores aren't stable across index rebuilds.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z
        .string()
        .min(1, "Query parameter 'q' is required")
        .describe("Full-text search query."),
      type: z.string().describe("Restrict to a single type.").optional(),
      state: z
        .enum(ITEM_STATES as unknown as [string, ...string[]])
        .describe("Filter by lifecycle state.")
        .optional(),
      tier: z
        .enum(["library", "feed", "all"])
        .describe("Filter by tier; `all` or absent means unfiltered.")
        .optional(),
      /** Opt-in inclusions, comma-separated. `system` includes
       *  `system.*` records, which are excluded from search results by
       *  default (operational items are not part of the user data tier). */
      include: z
        .string()
        .describe("Comma-separated opt-in inclusions, e.g. `system`.")
        .optional(),
      /** Comma-separated tag list. Items must have ALL specified tags. */
      tags: z
        .string()
        .describe("Comma-separated tags; items must match all (AND).")
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum results to return."),
      offset: z.coerce
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .default(0)
        .describe("Number of results to skip for paging."),
      filter: z
        .string()
        .describe("Structured filter expression, as on `GET /items`.")
        .optional(),
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

export function searchRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(searchRoute, async (c) => {
    requireAuth(c);

    const { q, type, state, tier, tags, limit, offset, filter, include } =
      c.req.valid("query");

    // Business logic validation beyond Zod
    if (type && !isValidTypeIdentifier(type)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    if (type) requireTypeAccess(c, type, "read");

    const allowed_types = getTypeFilter(c);

    // Tier filter, matching `/items`. `all` and absent both mean
    // unfiltered; `library` and `feed` narrow the scope.
    const tierFilter: "library" | "feed" | undefined =
      tier === "library" ? "library" : tier === "feed" ? "feed" : undefined;

    const tagsFilter = tags
      ? tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : undefined;

    const includeSet = new Set(
      (include ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    const includeSystemTypes = includeSet.has("system");
    const typeIsSystemTarget =
      typeof type === "string" && type.startsWith("system.");
    const excludeSystemTypes = !includeSystemTypes && !typeIsSystemTarget;

    // Source-filter lever — only narrows when a specific type is requested.
    const callerKeyForSearch = c.get("apiKey");
    const callerTenantIdForSearch = callerKeyForSearch?.tenant_id;
    const tenantConfigForSearch =
      callerTenantIdForSearch && storage.tenants
        ? await storage.tenants.getConfig(callerTenantIdForSearch)
        : null;
    const enforcementForSearch = resolveEnforcement(
      tenantConfigForSearch,
      callerKeyForSearch,
    );
    const sourcesFilter =
      typeof type === "string"
        ? (getSourceFilter(enforcementForSearch, type) ?? undefined)
        : undefined;

    const results = await storage.search.search(q.trim(), {
      tenantId: c.get("apiKey")?.tenant_id,
      type,
      state: state as ItemState | undefined,
      tier: tierFilter,
      sources: sourcesFilter,
      exclude_system_types: excludeSystemTypes,
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
