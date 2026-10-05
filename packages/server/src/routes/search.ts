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
  NextCursorSchema,
  resolveStateFilter,
} from "./_schemas.js";
import { readableMetadata } from "./_extension-reach.js";
import { excludesSystemTypes } from "./_system-type-visibility.js";
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
    item: ItemSchema.describe("The matching item."),
    metadata: MetadataSchema.describe(
      "The item's tags and the extensions you can read.",
    ),
    relevance_score: z
      .number()
      .describe(
        "How well the item matches `q`: the absolute value of its BM25 score, so higher is better. Scores depend on the rows indexed, so compare them only within one search.",
      ),
    snippet_html: z
      .string()
      .optional()
      .describe(
        "An excerpt of at most 32 words from the text that matches best, with each matched word in `<mark>` tags and `...` where the text is cut. Absent if there is none.",
      ),
  })
  .openapi("SearchResult", {
    description:
      "A search result is an item that matches the query, with its metadata and how well it matches.",
  });

const SearchResultPageSchema = z
  .object({
    data: z
      .array(SearchResultSchema)
      .describe("The results, best match first."),
    next_cursor: NextCursorSchema,
  })
  .openapi("SearchResultPage", {
    description: "One page of search results.",
  });

const searchRoute = createRoute({
  operationId: "searchItems",
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Search items",
  description:
    "Returns a page of the items you can read whose text properties or tags match `q`, ranked by BM25 relevance, with ties ordered by item ID.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    query: z.object({
      q: z
        .string()
        .min(1, "Query parameter 'q' is required")
        .refine((q) => !q.includes("\0"), "Query parameter 'q' holds a NUL")
        .describe(
          "The text to search for. Marfa matches every word by its stem, in any order, and the last word as the start of a word. Wrap the query in double quotes to match a phrase.",
        ),
      type: z
        .string()
        .describe(
          "Only return items of this type or a subtype. A wildcard such as `core.*` matches every type under that prefix.",
        )
        .optional(),
      state: z
        .string()
        .describe(
          `Only return items in this lifecycle state. Without it, you get \`active\` items. \`${ALL_STATES}\` searches every state, but trashed items are never searchable.`,
        )
        .optional(),
      tier: z
        .enum(["library", "feed", "all"])
        .describe(
          "Only return items in this tier. Omit it or send `all` for both tiers.",
        )
        .optional(),
      /** The rule deciding whether `system` applies, and why, is in
       *  `_system-type-visibility.ts`, shared by every door that takes it. */
      include: z
        .string()
        .describe(
          "Comma-separated extras. `system` also returns `system.*` items, which are left out by default. A `system.` type filter does the same.",
        )
        .optional(),
      /** Comma-separated tag list. Items must have ALL specified tags. */
      tags: z
        .string()
        .describe(
          "Comma-separated tags. Only return items that carry all of them.",
        )
        .optional(),
      limit: pageLimit({ max: 100, default: 20 }),
      cursor: pageCursor(),
      filter: z
        .string()
        .describe(
          "A filter expression, as on `GET /items`. A term naming an edge type, `edge[<type>]` or `backref[<type>]`, matches by relationship and needs read on that edge type.",
        )
        .optional(),
      occurred_after: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only return items whose own time (`occurred_at`, else `created_at`) is after this RFC 3339 time.",
        ),
      occurred_before: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only return items whose own time (`occurred_at`, else `created_at`) is before this RFC 3339 time.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: SearchResultPageSchema,
        },
      },
      description:
        "Returns a page of results. Each page runs the search again, so a change between two pages can repeat or skip a result. Marfa reads at most 10,000 results deep: the page that reaches that depth has `next_cursor: null`.",
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
        "- `missing_required_field`: `q` is missing.\n- `validation_error`: a parameter is unknown or invalid, such as a `state` that isn't a lifecycle state or `any`, a time that isn't an instant, or a `cursor` from another search.\n- `unknown_type`: `type` is a concrete type that nothing registers.",
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
        "- `type_not_permitted`: your credential reaches no type, or `type` names a type you can't read with none readable under it.\n- `edge_permission_denied`: the filter has an `edge` or `backref` term for an edge type you can't read.",
    },
  },
});

export function searchRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(searchRoute, async (c) => {
    requireAuth(c);

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
