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
  id: z.string(),
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
  method: "get",
  path: "/{id}/versions",
  tags: ["Items"],
  summary: "List item versions",
  description:
    "Returns the version-snapshot history for one item, newest first. Each snapshot carries the version number, the timestamp of the update that produced it, the full properties at that version, and the credential that wrote it.\n\nSnapshots are thinned on a rolling schedule — every snapshot in the recent window, one per calendar day in the daily window, one per ISO week in the weekly window, dropped beyond. The most recent snapshot is never thinned. To restore from a version, fetch its properties and re-send them through `PATCH /items/{id}` — the restore becomes a new forward version. See [Versions](/concepts/versions).",
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

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const versions = await storage.versions.list(id);
    return c.json({ versions }, 200);
  });

  return router;
}
