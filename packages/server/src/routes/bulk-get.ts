/**
 * Bulk read of items by id.
 *
 *   POST /items/bulk-get — id-list-in: caller provides explicit item ids and
 *                          gets back the items in one round-trip. Optional
 *                          `include` takes the same tokens as GET /items:
 *                          edges / metadata / extensions hydrate an extra,
 *                          and system widens which items come back.
 *
 * Read-only counterpart to POST /items/bulk (the upsert path). Every id is
 * resolved through the SAME space-scoped store method the single-item GET
 * uses, so a caller can only ever see items in its own space. Items the
 * caller cannot read — wrong space, type not permitted, soft-deleted — are
 * silently omitted, never errored, mirroring the list endpoint's
 * implicit-denial shape: one missing id does not 404 the whole request.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, checkTypeAccess } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { hydrateEdgesForItems } from "./_edges-hydrate.js";
import { hydrateExtensionsForItems } from "./_extensions-hydrate.js";
import { resolveOrphanScope, withOrphanState } from "./_orphaned.js";
import { ItemSchema, MetadataSchema } from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cap on the number of ids per call. A read fan-out is cheaper than the
 * upsert path (`MAX_BULK_ITEMS` = 5000), but a single batched `IN (...)`
 * query plus per-id permission checks and hydration should stay bounded so a
 * pathological request can't pin a worker. 100 matches the page-size ceiling
 * callers already reason about elsewhere (the 200 list-`limit` max, the
 * 100-tag-per-item cap) and is the documented default for this surface.
 */
const MAX_BULK_GET_IDS = 100;

const INCLUDE_TOKENS = ["edges", "metadata", "extensions", "system"] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BulkGetRequestSchema = z.object({
  ids: z.array(z.string()).describe("Item ids to fetch (max 100)."),
  include: z
    .array(z.enum(INCLUDE_TOKENS))
    .optional()
    .describe(
      "`edges`, `metadata` and `extensions` hydrate those extras inline on the " +
        "items already being returned. `system` is different in kind: it widens " +
        "the result to include `system.*` items, which are omitted by default. " +
        "Mirrors the GET /items `include` tokens.",
    ),
});

const BulkGetResponseSchema = z.object({
  /**
   * The resolved items, in no guaranteed order relative to the request. Items
   * the caller cannot read (wrong space, type not permitted, trashed, or
   * non-existent) are omitted, so `items.length <= ids.length`.
   */
  items: z.array(ItemSchema),
  /**
   * Present only when `include` carries `metadata`. One entry per returned
   * item, keyed by `item_id`, filtered to what the caller may see.
   */
  metadata: z.array(MetadataSchema).optional(),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const bulkGetRoute = createRoute({
  method: "post",
  path: "/bulk-get",
  operationId: "bulkGetItems",
  tags: ["Items"],
  summary: "Bulk get items by id",
  description:
    "Reads up to 100 items by id in one round-trip. Space-scoped and " +
    "permission-filtered exactly like the single-item GET: ids the caller " +
    "cannot read (other space, type not permitted, trashed, or missing) " +
    "are silently omitted rather than erroring the whole request. Optional " +
    "`include` takes the same tokens as GET /items: `edges`, `metadata` and " +
    "`extensions` hydrate an extra inline, while `system` widens the result " +
    "to include `system.*` items, which are omitted by default.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: BulkGetRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: BulkGetResponseSchema },
      },
      description: "The readable subset of the requested items",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error", "invalid_id"]),
        },
      },
      description: "Validation error (too many ids, or a malformed id)",
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function bulkGetRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(bulkGetRoute, async (c) => {
    const apiKey = requireAuth(c);
    const body = c.req.valid("json");
    const ids = body.ids;

    if (ids.length > MAX_BULK_GET_IDS) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_BULK_GET_IDS)} ids per call`,
        { cap: MAX_BULK_GET_IDS, provided: ids.length },
      );
    }
    for (const id of ids) {
      if (!isValidId(id)) {
        throw new MarfaError(ErrorCode.INVALID_ID, `Invalid item id: ${id}`, {
          id,
        });
      }
    }

    const includeSet = new Set(body.include ?? []);
    const includeEdges = includeSet.has("edges");
    const includeMetadata = includeSet.has("metadata");
    const includeExtensions = includeSet.has("extensions");
    const includeSystem = includeSet.has("system");

    if (ids.length === 0) {
      return c.json(
        includeMetadata ? { items: [], metadata: [] } : { items: [] },
        200,
      );
    }

    // Space fence: `items.getMany` filters by `space_id` (the same scope
    // the single-item GET threads via `items.get(id, space_id)`) and drops
    // trashed rows. A caller with a space scope therefore never sees rows
    // outside it; for a space-less key (the operator key, and nothing
    // self-host) the scope is the whole instance, matching the single GET.
    const spaceId = apiKey.space_id;
    const found = await storage.items.getMany(ids, spaceId);

    // Permission filter: same `checkTypeAccess(..., "read")` gate the
    // single-item GET applies, but here a denial omits the item instead of
    // 403ing — mirroring the list endpoint's implicit-denial shape. `system.*`
    // items stay out unless the caller opts in via `include: ["system"]`,
    // matching the list endpoint's default exclusion. Preserve request order
    // by iterating `ids`; de-dupe so a repeated id appears once.
    const seen = new Set<string>();
    const visible: Item[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const item = found.get(id);
      if (!item) continue;
      if (!includeSystem && item.type.startsWith("system.")) continue;
      try {
        checkTypeAccess(apiKey, item.type, "read");
      } catch {
        // Type not permitted → implicit denial, omit silently.
        continue;
      }
      visible.push(item);
    }

    const visibleIds = visible.map((item) => item.id);

    const edgesMap = includeEdges
      ? await hydrateEdgesForItems(storage, visibleIds)
      : null;
    const extensionsMap = includeExtensions
      ? await hydrateExtensionsForItems(storage, visibleIds, apiKey)
      : null;

    // One resolution for the whole batch — see `_orphaned.ts`.
    const orphanScope = await resolveOrphanScope(storage, visible);

    const decorated = visible.map((item) => {
      const withOrphan = withOrphanState(item, orphanScope);
      const withEdges = edgesMap
        ? { ...withOrphan, edges: edgesMap.get(item.id) ?? {} }
        : withOrphan;
      return extensionsMap
        ? { ...withEdges, extensions: extensionsMap.get(item.id) ?? {} }
        : withEdges;
    });

    if (includeMetadata) {
      const metadataList = await storage.metadata.getMany(visibleIds);
      const metadataMap = new Map(metadataList.map((m) => [m.item_id, m]));
      const metadata = visible.map((item) =>
        filterMetadataForCaller(
          metadataMap.get(item.id) ?? {
            item_id: item.id,
            tags: [],
            extensions: {},
          },
          apiKey,
        ),
      );
      return c.json({ items: decorated, metadata }, 200);
    }

    return c.json({ items: decorated }, 200);
  });

  return router;
}
