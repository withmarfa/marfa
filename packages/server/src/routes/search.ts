import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  ITEM_STATES,
  GLOBAL_TYPE_WILDCARD,
  isValidTypePattern,
  resolveEnforcement,
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
import { resolveOrphanScope, withOrphanState } from "./_orphaned.js";
import { refuseRenamedTimeQueryParams } from "./_renamed-time-filters.js";
import {
  refuseUnknownQueryParams,
  UNKNOWN_PARAM_NOTE,
} from "./_unknown-query-keys.js";

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
  description: `Full-text search across the space's items, indexing textual properties and tags, ranked by relevance with a configurable recency boost. Accepts the same filters as \`GET /items\` — including its two time bounds, which read the item's own time — and uses \`limit\` / \`offset\` paging rather than a cursor; absolute scores aren't stable across index rebuilds. ${UNKNOWN_PARAM_NOTE}`,
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
      timestamp_after: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Lower bound on the item's own time — `timestamp`, falling back to `created_at` (inclusive). An RFC 3339 timestamp in any valid spelling; it is normalized before the comparison. Not the modification time.",
        ),
      timestamp_before: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Upper bound on the item's own time — `timestamp`, falling back to `created_at` (inclusive).",
        ),
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

    // Before anything reads the validated query, which has already had an
    // unknown key stripped from it. This door never carried the retired
    // names, but the published rename tells a caller they belong on every
    // filtered read — and an absence discovered at 200 over the whole
    // corpus is the silence the rename was refused for.
    //
    // No modification-time filter is named: this door has none, and
    // sending a caller to a parameter it would strip is that same failure
    // reached through the refusal.
    refuseRenamedTimeQueryParams(c.req.raw.url, { catchUpFilter: "none" });
    refuseUnknownQueryParams(c.req.raw.url, searchRoute.request.query);

    const {
      q,
      type,
      state,
      tier,
      tags,
      limit,
      offset,
      filter,
      include,
      timestamp_after: timestampAfter,
      timestamp_before: timestampBefore,
    } = c.req.valid("query");

    // Same grammar as `GET /items?type=`, because the parameter means the
    // same thing on both: the named type and everything under it. Validating
    // it as a bare identifier here made the explicit `parent.*` spelling a
    // 400 on search while it was a subtree read on the listing.
    //
    // The value compiles into a `LIKE` predicate, so it has to clear the
    // pattern grammar rather than an "ends with `.*`" shape check. The global
    // `*` is rejected on top, matching the listing: "everything" is a search
    // with no type at all, and a type filter matching every type would slip
    // past the per-type enforcement levers keyed off this parameter.
    if (type && (type === GLOBAL_TYPE_WILDCARD || !isValidTypePattern(type))) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    if (type) requireTypeAccess(c, type, "read");

    const { allowed: allowed_types, excluded: excluded_types } =
      getTypeFilter(c);

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

    const callerKeyForSearch = c.get("apiKey");
    const callerSpaceIdForSearch = callerKeyForSearch?.space_id;
    const spaceConfigForSearch =
      callerSpaceIdForSearch && storage.spaces
        ? await storage.spaces.getConfig(callerSpaceIdForSearch)
        : null;
    const enforcementForSearch = resolveEnforcement(
      spaceConfigForSearch,
      callerKeyForSearch,
    );
    const results = await storage.search.search(q.trim(), {
      spaceId: c.get("apiKey")?.space_id,
      type,
      state: state as ItemState | undefined,
      tier: tierFilter,
      // Per row, from the row's own type — see the note on `ItemFilters`.
      source_filter: enforcementForSearch.source_filter,
      exclude_system_types: excludeSystemTypes,
      tags: tagsFilter,
      filter,
      timestamp_after: timestampAfter,
      timestamp_before: timestampBefore,
      allowed_types,
      excluded_types,
      limit,
      offset: offset > 0 ? offset : undefined,
    });

    const apiKey = c.get("apiKey");
    // One resolution for the whole result set — see `_orphaned.ts`.
    const orphanScope = await resolveOrphanScope(
      storage,
      results.map((r) => r.item),
    );
    const filtered = results.map((r) => ({
      ...r,
      item: withOrphanState(r.item, orphanScope),
      metadata: filterMetadataForCaller(r.metadata, apiKey),
    }));
    return c.json({ results: filtered }, 200);
  });

  return router;
}
