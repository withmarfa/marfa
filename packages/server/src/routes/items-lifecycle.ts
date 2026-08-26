import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireTypeAccess,
  requireRowWritable,
  itemProvenanceSource,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { publish } from "../pubsub.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ItemWithMetadataSchema } from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";
import { resolveOrphanScopeForOwnWrite, withOrphanState } from "./_orphaned.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string().describe("Item id to act on"),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const restoreItemRoute = createRoute({
  operationId: "restoreItem",
  method: "post",
  path: "/{id}/restore",
  tags: ["Items"],
  summary: "Restore a trashed item",
  description:
    "Restores a trashed item to active. Trashed items are auto-purged after the retention window, so a restore only succeeds while the row still exists.",
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

const transitionItemRoute = createRoute({
  operationId: "transitionItem",
  method: "post",
  path: "/{id}/transition",
  tags: ["Items"],
  summary: "Transition item state",
  description:
    "Moves the item to the supplied lifecycle state. Going straight from trashed to archived is rejected — restore to active first.",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
            "invalid_transition",
          ]),
        },
      },
      description: "Invalid transition",
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

export function itemsLifecycleRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /items/:id/restore
  router.openapi(restoreItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    const spaceId = c.get("apiKey")?.space_id;
    // Fetch the (trashed) item to get its type, then run the permission
    // gate BEFORE calling `restore()`. Running the write first would
    // leave the item restored with no rollback if the gate throws.
    // `getIncludingTrashed` sees past the normal trashed-is-invisible
    // filter.
    const pending = await storage.items.getIncludingTrashed(id, spaceId);
    if (!pending) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    requireTypeAccess(c, pending.type, "write");
    requireRowWritable(c.get("apiKey"), pending);
    const restored = await storage.items.restore(id, spaceId);
    const metadata = await storage.metadata.get(id);
    await publish({
      type: "restored",
      item: restored,
      metadata,
      spaceId,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.restore",
      resource_type: "item",
      resource_id: id,
    });
    return c.json(
      {
        item: withOrphanState(
          restored,
          await resolveOrphanScopeForOwnWrite(
            storage,
            [restored],
            itemProvenanceSource(c.get("apiKey")),
          ),
        ),
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
      },
      200,
    );
  });

  // POST /items/:id/transition
  router.openapi(transitionItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const state = body.state;
    // body.state is constrained to the lifecycle enum by the route Zod;
    // typeof / truthiness check would be unreachable.

    requireAuth(c);
    const spaceId = c.get("apiKey")?.space_id;
    const item = await storage.items.get(id, spaceId);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    requireTypeAccess(c, item.type, "write");
    requireRowWritable(c.get("apiKey"), item);
    const updated = await storage.items.transition(id, state, spaceId);
    const metadata = await storage.metadata.get(id);
    await publish({
      type: "state_changed",
      item: updated,
      metadata,
      spaceId,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "item.transition",
      resource_type: "item",
      resource_id: id,
      details: { from_state: item.state, to_state: state },
    });
    return c.json(
      {
        // A transition is the case the contract most has to survive: an
        // archive on an orphaned row must not answer as though the row had
        // no integration behind it.
        item: withOrphanState(
          updated,
          await resolveOrphanScopeForOwnWrite(
            storage,
            [updated],
            itemProvenanceSource(c.get("apiKey")),
          ),
        ),
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
      },
      200,
    );
  });

  return router;
}
