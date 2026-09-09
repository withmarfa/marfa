import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireTypeAccess,
  requireRowWritable,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { publish } from "../pubsub.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ItemWithMetadataSchema } from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";
import {
  createOwnershipGuard,
  resolveOrphanScopeForOwnWrite,
  withOrphanState,
} from "./_orphaned.js";

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
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["provenance_collision"]),
        },
      },
      description:
        "An integration may only destroy what it wrote. The row's recorded writer is another connection that is still installed, so the gesture is refused; the response names the owning connection. A row whose writer has been uninstalled is not refused.",
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
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["provenance_collision"]),
        },
      },
      description:
        "An integration may only destroy what it wrote. The row's recorded writer is another connection that is still installed, so the gesture is refused; the response names the owning connection. A row whose writer has been uninstalled is not refused.",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function itemsLifecycleRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  /**
   * D64: an integration may only destroy what it wrote.
   *
   * Applied to the lifecycle axis as well as the delete doors, because the
   * ruling follows the actor rather than the gesture — and because trashing
   * through `POST /items/{id}/transition` reaches exactly the rows that
   * `DELETE /items/{id}` does. Guarding one and not the other would move the
   * gap rather than close it.
   *
   * Restore is guarded too. It is not destructive, but it is a lifecycle
   * write on a row this connection does not own, and the rule is about the
   * actor: a connection that may not trash a sibling's row has no better
   * claim to un-trash one.
   *
   * **Built per request, never once per router.** The guard memoizes the
   * space's live-connection walk, and that answer is good for exactly the
   * request that took it — held across requests it reports an uninstalled
   * connection as live for the life of the process, which turns the guard
   * from a protection into a permanent refusal nobody can clear.
   */
  const lifecycleGuard = (): ReturnType<typeof createOwnershipGuard> =>
    createOwnershipGuard(storage, "destroy");

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
    await lifecycleGuard()(c.get("apiKey"), pending);
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
            c.get("apiKey"),
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
    await lifecycleGuard()(c.get("apiKey"), item);
    // **No live-connection refusal here.** It would sit behind
    // `requireTypeAccess`, which refuses a `system.connection` write to
    // every credential the product can mint: the reserved namespace admits
    // only `is_operator`, the operator key's own type permissions are
    // empty, and a runtime credential's carve-out names `system.activity`
    // alone. A refusal below that gate can never answer, and unreachable
    // enforcement is worse than none because it reads as a protection
    // somebody is relying on. The gate that does the work is the type
    // access check above, and `item-state-doors.test.ts` pins it there.
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
            c.get("apiKey"),
          ),
        ),
        metadata: filterMetadataForCaller(metadata, c.get("apiKey")),
      },
      200,
    );
  });

  return router;
}
