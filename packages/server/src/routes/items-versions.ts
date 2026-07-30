import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireTypeAccess } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string().describe("Item id whose version history to return"),
});

const VersionSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  version: z.number(),
  properties: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  device: z.string().optional(),
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
          schema: z.object({
            versions: z.array(VersionSchema),
          }),
        },
      },
      description: "Version history",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: "Item not found",
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

    const item = await storage.items.get(id, c.get("apiKey")?.space_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const versions = await storage.versions.list(id);
    return c.json({ versions }, 200);
  });

  return router;
}
