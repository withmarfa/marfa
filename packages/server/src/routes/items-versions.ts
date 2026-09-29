import { ITEM_NOT_FOUND, READ_REFUSED } from "./_item-refusals.js";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireReadableRow } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { VersionPageSchema } from "./_schemas.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string().describe("Item id whose version history to return"),
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
    "Returns the version-snapshot history for one item, newest first. Older snapshots are thinned on a rolling schedule and the most recent is never dropped, so the history is not guaranteed to be contiguous.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
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
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "The id is not a well-formed item id.",
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
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`),
    );
    const versions = await storage.versions.list(id);
    return c.json({ data: versions, next_cursor: null }, 200);
  });

  return router;
}
