import { createRoute, z } from "@hono/zod-openapi";
import { resolveEnforcement } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import {
  requireAuth,
  requireTypeAccess,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  ALL_STATES,
  ItemSchema as BaseItemSchema,
  MetadataSchema as BaseMetadataSchema,
  resolveStateFilter,
} from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";
import { excludesSystemTypes } from "./_system-type-visibility.js";
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
  description: `Full-text search across every item the caller can read, indexing textual properties and tags, ranked by relevance with a configurable recency boost. Accepts the same filters as \`GET /items\` — including its two time bounds, which read the item's own time — and uses \`limit\` / \`offset\` paging rather than a cursor; absolute scores aren't stable across index rebuilds. ${UNKNOWN_PARAM_NOTE}`,
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z
        .string()
        .min(1, "Query parameter 'q' is required")
        .describe("Full-text search query."),
      type: z
        .string()
        .describe(
          "Restrict to a single type, subtypes included. A concrete identifier this instance does not know is refused with 400 `unknown_type`.",
        )
        .optional(),
      state: z
        .string()
        .describe(
          `Filter by lifecycle state. Omitting the parameter answers the active state, as a listing does, so a search never answers a row a listing hides. \`${ALL_STATES}\` widens to every state, the same sentinel the listing takes. A row in the bin is not indexed, so it is not matched under any value.`,
        )
        .optional(),
      tier: z
        .enum(["library", "feed", "all"])
        .describe("Filter by tier; `all` or absent means unfiltered.")
        .optional(),
      /** What the token does is in the published description rather than
       *  restated here, and the rule deciding whether it applies is in
       *  `_system-type-visibility.ts` rather than in this file. That module
       *  is also where the rationale lives now: this comment used to say it
       *  was recorded nowhere, which was true when written and stopped being
       *  so when the rule three doors were each spelling out became one
       *  function. An earlier draft of this comment invented a rationale,
       *  which is why it then asserted nothing. */
      include: z
        .string()
        .describe(
          "Comma-separated opt-in inclusions. `system` widens the row set to " +
            "include `system.*` items, which are excluded by default. A `type` " +
            "filter in the `system.` namespace, concrete or wildcard, opts in " +
            "on its own without the token. " +
            "It is the only token this route reads.",
        )
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
      occurred_after: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Lower bound on the item's own time — `occurred_at`, falling back to `created_at` (exclusive). An RFC 3339 instant in any valid spelling; it is normalized before the comparison. Not the modification time.",
        ),
      occurred_before: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Upper bound on the item's own time — `occurred_at`, falling back to `created_at` (exclusive).",
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
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error", "unknown_type"]),
        },
      },
      description:
        "An invalid type pattern, a time bound that is not an instant, " +
        "a `state` that is neither a lifecycle state nor the widening " +
        "sentinel, or an unrecognized query parameter.",
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
      occurred_after: occurredAfter,
      occurred_before: occurredBefore,
    } = c.req.valid("query");

    // Grammar, the global wildcard and an unknown concrete type, decided once
    // for every list surface; the reasoning is at `assertTypeFilter`.
    assertTypeFilter(type);

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
    // Through the shared rule rather than restated: this door and the item
    // list both wrote it out, and the bulk-action door wrote nothing.
    const excludeSystemTypes = excludesSystemTypes(includeSet, type);

    // The same resolution the listing and the export doors use, so `any`
    // means the same thing on all three. `any` is a widening rather than a
    // state, so it never reaches the column comparison.
    const { state: resolvedState, all_states: allStates } =
      resolveStateFilter(state);

    const callerKeyForSearch = c.get("apiKey");
    const instanceConfigForSearch = await readInstanceConfig(storage.settings);
    const enforcementForSearch = resolveEnforcement(
      instanceConfigForSearch,
      callerKeyForSearch,
    );
    const results = await storage.search.search(q.trim(), {
      type,
      state: resolvedState,
      all_states: allStates,
      tier: tierFilter,
      // Per row, from the row's own type — see the note on `ItemFilters`.
      source_filter: enforcementForSearch.source_filter,
      exclude_system_types: excludeSystemTypes,
      tags: tagsFilter,
      filter,
      occurred_after: occurredAfter,
      occurred_before: occurredBefore,
      allowed_types,
      excluded_types,
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
