import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  readsSomeType,
  requireReadableRow,
  typeReader,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageLimit,
  pageCursor,
} from "../page-limits.js";
import { VersionPageSchema } from "./_schemas.js";
import { refuseUnknownQueryParams } from "./_unknown-query-keys.js";
import { ITEM_NOT_FOUND_ON_READ, READ_REFUSED } from "./_item-refusals.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string().describe("The ID of the item."),
});

const PageQuery = z.object({
  limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
  cursor: pageCursor(),
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
  description:
    "Returns a page of the item's version snapshots, oldest first. Marfa thins older snapshots over time, so the history can have gaps.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
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
      description:
        "Returns the snapshots you can read. Each holds the properties before the write that replaced them, and the `type`, `tier`, `occurred_at` and `source_id` the item had at that version. Snapshots written under a type you can't read are left out, and a page fills past them.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "validation_error"]),
        },
      },
      description:
        "- `invalid_id`: the ID is not a valid item ID.\n- `validation_error`: a query parameter is unknown or out of range, or `cursor` is malformed or came from another listing.",
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
      description: ITEM_NOT_FOUND_ON_READ,
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
