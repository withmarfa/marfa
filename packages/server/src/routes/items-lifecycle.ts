import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode, isValidId } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, requireTypeAccess } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { publish } from "../pubsub.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";
import { ItemWithMetadataSchema } from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const restoreItemRoute = createRoute({
  method: "post",
  path: "/{id}/restore",
  tags: ["Items"],
  summary: "Restore a trashed item",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description: "Item restored",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

const transitionItemRoute = createRoute({
  method: "post",
  path: "/{id}/transition",
  tags: ["Items"],
  summary: "Transition item state",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            state: z.enum(["active", "archived", "trashed"]),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description: "Item state changed",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid transition",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function itemsLifecycleRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /items/:id/restore
  router.openapi(restoreItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    // Fetch the (trashed) item to get its type, then run the permission
    // gate BEFORE calling `restore()`. Previously the write happened
    // first and then the gate — a throwing gate would leave the item
    // restored with no rollback. `getIncludingTrashed` sees past the
    // normal trashed-is-invisible filter.
    const pending = await storage.items.getIncludingTrashed(id, tenantId);
    if (!pending) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    requireTypeAccess(c, pending.type, "write");
    const restored = await storage.items.restore(id, tenantId);
    const metadata = await storage.metadata.get(id);
    await publish({
      type: "restored",
      item: restored,
      metadata,
      tenantId,
      ...c.var.cycle,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.restore",
      resource_type: "item",
      resource_id: id,
    });
    return c.json(
      {
        item: restored,
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
      },
      200,
    );
  });

  // POST /items/:id/transition
  router.openapi(transitionItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const state = body.state;
    // body.state is constrained to the lifecycle enum by the route Zod;
    // typeof / truthiness check would be unreachable.

    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tenantId);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    requireTypeAccess(c, item.type, "write");
    const updated = await storage.items.transition(id, state, tenantId);
    const metadata = await storage.metadata.get(id);
    await publish({
      type: "state_changed",
      item: updated,
      metadata,
      tenantId,
      ...c.var.cycle,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.transition",
      resource_type: "item",
      resource_id: id,
      details: { from_state: item.state, to_state: state },
    });
    return c.json(
      {
        item: updated,
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
      },
      200,
    );
  });

  return router;
}
