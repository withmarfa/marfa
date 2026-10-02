import { ITEM_NOT_FOUND, READ_REFUSED } from "./_item-refusals.js";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireReadableRow, typeReader } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../page-limits.js";
import { VersionPageSchema } from "./_schemas.js";
import {
  refuseUnknownQueryParams,
  UNKNOWN_PARAM_NOTE,
} from "./_unknown-query-keys.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string().describe("Item id whose version history to return"),
});

const PageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(MIN_PAGE_LIMIT)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .default(DEFAULT_PAGE_LIMIT)
    .describe(
      `Page size, ${String(MIN_PAGE_LIMIT)}–${String(MAX_PAGE_LIMIT)} (default ${String(DEFAULT_PAGE_LIMIT)})`,
    ),
  cursor: z
    .string()
    .optional()
    .describe("Opaque cursor from a previous page's `next_cursor`."),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listVersionsRoute = createRoute({
  operationId: "listItemVersions",
  method: "get",
  path: "/{id}/versions",
  tags: ["Items"],
  summary: "List item versions",
  description: `Returns the version-snapshot history for one item, oldest first, paged by cursor. Each snapshot carries the properties the row held before the write that left it behind and the \`type\`, \`tier\`, \`occurred_at\` and \`source_id\` the row had at that version. Requires read access to the item's type now, and a snapshot is answered only where the credential may also read the type it was written under: a row moved from a type the credential may not read keeps those snapshots, and they are left out rather than refused, so a page can come back short. Older snapshots are thinned on a rolling schedule and the most recent is never dropped, so the history is not guaranteed to be contiguous. ${UNKNOWN_PARAM_NOTE}`,
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: PageQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: VersionPageSchema,
        },
      },
      description: "Version history",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "validation_error"]),
        },
      },
      description:
        "The id is not a well-formed item id, or a query parameter is unknown or out of range, or the cursor is malformed or was issued by another listing.",
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
      description: READ_REFUSED,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND,
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function itemsVersionsRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // GET /items/:id/versions
  router.openapi(listVersionsRoute, async (c) => {
    refuseUnknownQueryParams(c.req.raw.url, PageQuery);
    const { id } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    const page = await storage.versions.list(id, {
      reads: typeReader(c),
      limit,
      ...(cursor !== undefined && { cursor }),
    });
    return c.json(page, 200);
  });

  return router;
}
