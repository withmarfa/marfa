import { createRoute, z } from "@hono/zod-openapi";
import {
  MymeError,
  ErrorCode,
  ITEM_STATES,
  isValidTypeIdentifier,
  resolveEnforcement,
  getSourceFilter,
} from "@mymehq/shared";
import type { ItemState } from "@mymehq/shared";
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
  snippet: z.string().optional(),
});

const searchRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Search items",
  description:
    "Full-text search across the tenant's items. Indexes textual properties (body, title, description, name, and other string-typed fields not flagged `searchable: false`) plus tags. Ranking is by relevance with a configurable recency boost.\n\nAccepts the same filter parameters as `GET /items` — narrow by `type`, `state`, `tier`, `tags`, source, edge / backref clauses — so the search query and the filter set compose. `tags` is comma-separated with AND semantics.\n\nUses `limit` / `offset` pagination rather than cursors. Result ordering is stable for the query's lifetime; absolute `score` values are not guaranteed across index rebuilds. See [Search and query](/api/search-and-query).",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z.string().min(1, "Query parameter 'q' is required"),
      type: z.string().optional(),
      state: z.enum(ITEM_STATES as unknown as [string, ...string[]]).optional(),
      tier: z.enum(["library", "feed", "all"]).optional(),
      /** Opt-in inclusions, comma-separated. `system` includes the platform
       *  `system.*` records, which are excluded from search results by
       *  default per TSC42 §4. */
      include: z.string().optional(),
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
      throw new MymeError(
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

    // TSC42 §5 source-filter lever — only narrows when a specific type is
    // requested.
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
