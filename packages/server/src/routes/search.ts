import { createHash } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError, resolveEnforcement } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import { assertFilterEdgeTermsReadable } from "./_edge-visibility.js";
import {
  requireAuth,
  getTypeFilter,
  readsSomeType,
} from "../middleware/auth.js";
import {
  SEARCH_CURSOR_KEY,
  decodeKeyedCursor,
  encodeKeyedCursor,
  type Storage,
} from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  ALL_STATES,
  ItemSchema,
  MetadataSchema,
  pageOf,
  resolveStateFilter,
} from "./_schemas.js";
import { readableMetadata } from "./_extension-reach.js";
import { excludesSystemTypes } from "./_system-type-visibility.js";
import { refuseUnknownQueryParams } from "./_unknown-query-keys.js";
import { pageLimit, pageCursor } from "../page-limits.js";

/** How deep the ranking is read; a cursor past it is refused. */
const MAX_SEARCH_DEPTH = 10_000;

/**
 * The position a search cursor carries, refused unless it was minted for
 * this same query. A position is only meaningful in the ranking it came
 * from, so the cursor carries a fingerprint of everything that decides the
 * ranking, and one from another query is refused rather than read as an
 * offset into this one.
 */
function searchOffset(cursor: string | undefined, query: string): number {
  if (cursor === undefined) return 0;
  const { v, id } = decodeKeyedCursor(cursor, SEARCH_CURSOR_KEY);
  if (id !== query) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "This cursor was issued for a different search and cannot be continued here. Re-read the first page with the same parameters.",
    );
  }
  const offset = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isInteger(offset) || offset >= MAX_SEARCH_DEPTH) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid pagination cursor",
    );
  }
  return offset;
}

/** Everything that decides a search's ranking, as one short string. */
function searchFingerprint(query: Record<string, unknown>): string {
  const ranking = { ...query };
  delete ranking.cursor;
  delete ranking.limit;
  return createHash("sha256")
    .update(JSON.stringify(ranking, Object.keys(ranking).sort()))
    .digest("base64url")
    .slice(0, 22);
}

// A search row carries the shared shapes rather than a loosened copy of
// them: `rowToItem` and `rowToMetadata` build both, the same two builders
// every other door uses, so the ranker's columns never reach a row. A
// loosened copy is also a second shape in the document, since loosening
// drops the component name.
const SearchResultSchema = z
  .object({
    item: ItemSchema,
    metadata: MetadataSchema,
    relevance_score: z.number(),
    snippet_html: z.string().optional(),
  })
  .openapi("SearchResult");

const searchRoute = createRoute({
  operationId: "searchItems",
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Search items",
  description:
    "Full-text search across every item the caller can read, indexing textual properties and tags, ranked by BM25 relevance, hits of equal rank by item identifier. Accepts the same filters as `GET /items` (including its two time bounds, which read the item's own time) and pages by cursor like every list: pass `next_cursor` back as `cursor`. The ranking is recomputed on every page, so a row whose score moves between two reads can be seen twice or missed; absolute scores aren't stable across index rebuilds. The ranking is read at most 10,000 rows deep, and the page that reaches that depth answers `next_cursor: null`.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    query: z.object({
      q: z
        .string()
        .min(1, "Query parameter 'q' is required")
        .refine((q) => !q.includes("\0"), "Query parameter 'q' holds a NUL")
        .describe("Full-text search query."),
      type: z
        .string()
        .describe(
          "Restrict to one type, subtypes included. Refused `400 unknown_type` if nothing registers it, and `403 type_not_permitted` if the credential cannot read it or any type under it. A wildcard answers the readable types it matches.",
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
      /** The rule deciding whether `system` applies, and why, is in
       *  `_system-type-visibility.ts`, shared by every door that takes it. */
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
      limit: pageLimit({ max: 100, default: 20 }),
      cursor: pageCursor(),
      filter: z
        .string()
        .describe(
          "Structured filter expression, as on `GET /items`, including " +
            "its edge terms and their refusals: a term naming an edge " +
            "type the credential may not read is refused " +
            "`403 edge_permission_denied`. A `backref` term counts only " +
            "edges whose source the credential may read, so one anchored " +
            "on an item it may not read matches as one anchored on an id " +
            "no row holds; an `edge` term matches every edge it may read, " +
            "one to an item it may not read included.",
        )
        .optional(),
      occurred_after: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Lower bound on the item's own time: `occurred_at`, falling back to `created_at` (exclusive). An RFC 3339 instant in any valid spelling; it is normalized before the comparison. Not the modification time.",
        ),
      occurred_before: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Upper bound on the item's own time: `occurred_at`, falling back to `created_at` (exclusive).",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(SearchResultSchema, "SearchResultPage"),
        },
      },
      description: "Search results",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "validation_error",
            "unknown_type",
          ]),
        },
      },
      description:
        "`missing_required_field` when `q` is absent. An invalid type pattern, a time bound that is not an instant, " +
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "type_not_permitted",
            "edge_permission_denied",
          ]),
        },
      },
      description:
        "`type_not_permitted` when the credential reaches no type, or `type` names a registered type it cannot read and none under it. `edge_permission_denied` where a filter term names an edge type it cannot read: a term naming a relationship is a question, so it is refused rather than dropped.",
    },
  },
});

export function searchRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(searchRoute, async (c) => {
    requireAuth(c);

    // Read from the raw URL, because the validated query has already had
    // an unknown key stripped from it, and a filter the caller believes
    // applied would otherwise answer 200 over the whole corpus.
    refuseUnknownQueryParams(c.req.raw.url, searchRoute.request.query);

    const {
      q,
      type,
      state,
      tier,
      tags,
      limit,
      cursor,
      filter,
      include,
      occurred_after: occurredAfter,
      occurred_before: occurredBefore,
    } = c.req.valid("query");

    // Grammar, the global wildcard and an unknown concrete type, decided once
    // for every list surface; the reasoning is at `assertTypeFilter`.
    assertTypeFilter(c, type);

    // This door takes the same grammar `GET /items` takes, and it
    // compiles an edge term rather than ignoring one, so it asks the same
    // question of it. Two doors that disagreed about one term would be
    // the disclosure reached through the other one.
    assertFilterEdgeTermsReadable(c, filter);

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
    const fingerprint = searchFingerprint(c.req.valid("query"));
    const offset = searchOffset(cursor, fingerprint);
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
      readable_sources: { allowed: allowed_types, excluded: excluded_types },
      occurred_after: occurredAfter,
      occurred_before: occurredBefore,
      allowed_types,
      excluded_types,
      // One past the page, so the answer knows whether another follows.
      limit: Math.min(limit + 1, MAX_SEARCH_DEPTH - offset),
      offset: offset > 0 ? offset : undefined,
    });

    const apiKey = c.get("apiKey");
    const filtered = results.slice(0, limit).map((r) => ({
      ...r,
      metadata: readableMetadata(r.metadata, apiKey),
    }));
    const next = offset + limit;
    return c.json(
      {
        data: filtered,
        next_cursor:
          results.length > limit && next < MAX_SEARCH_DEPTH
            ? encodeKeyedCursor(String(next), fingerprint, SEARCH_CURSOR_KEY)
            : null,
      },
      200,
    );
  });

  return router;
}
