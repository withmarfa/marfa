import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, requireTypeAccess } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { publish } from "../pubsub.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ItemWithMetadataSchema } from "./_schemas.js";
import { filterMetadataForCaller } from "./util.js";

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
    "Restores a trashed item to active, and with it every row its trash took through a cascading edge such as `parent-of`, each announced `item.restored`; a row that was already in the bin when it was trashed stays there. Trashed items are auto-purged after the retention window, so a restore only succeeds while the row still exists.",
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
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "invalid_id",
            "invalid_transition",
            "validation_error",
          ]),
        },
      },
      description:
        "`invalid_id` for a malformed id. `invalid_transition` when the item is not trashed: there is nothing to restore it from. `validation_error` when `Idempotency-Key` is malformed.",
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
      description: "The credential may not write the item's type.",
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description: "The credential may not write the item's type.",
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

/**
 * Announces each row a restore brought back because the trash that took it
 * was undone, after the transaction that restored them has committed, as a
 * restore of its own.
 */
async function publishBroughtBack(
  storage: Storage,
  broughtBack: readonly Item[],
): Promise<void> {
  for (const item of broughtBack) {
    await publish({
      type: "restored",
      item,
      metadata: await storage.metadata.get(item.id),
    });
  }
}

export function itemsLifecycleRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /items/:id/restore
  router.openapi(restoreItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    // Fetch the (trashed) item to get its type, then run the permission
    // gate BEFORE calling `restore()`. Running the write first would
    // leave the item restored with no rollback if the gate throws.
    // `getIncludingTrashed` sees past the normal trashed-is-invisible
    // filter.
    const pending = await storage.items.getIncludingTrashed(id);
    if (!pending) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }
    requireTypeAccess(c, pending.type, "write");
    const { restored, broughtBack } = await storage.runInTransaction(
      async () => {
        const back = await storage.items.restoreBeneath(id);
        return { restored: await storage.items.restore(id), broughtBack: back };
      },
    );
    const metadata = await storage.metadata.get(id);
    await publish({
      type: "restored",
      item: restored,
      metadata,
    });
    await publishBroughtBack(storage, broughtBack);
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
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = c.req.valid("json");
    const state = body.state;
    // body.state is constrained to the lifecycle enum by the route Zod;
    // typeof / truthiness check would be unreachable.

    requireAuth(c);
    // Read past the trash, as `restore` above does, so a transition out of
    // it is judged by the type's graph: `trashed` admits `active` alone, and
    // the store's refusal names the move. Read through the trashed-invisible
    // getter, every trashed row answered 404 and the graph never spoke.
    const item = await storage.items.getIncludingTrashed(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    requireTypeAccess(c, item.type, "write");
    // **No live-connection refusal here, and two rules make it unreachable.**
    // The nearer one is in this file: a `system.*` type's lifecycle admits
    // only `active` to `revoked`, and this route's body schema cannot name
    // `revoked`, so the store refuses every transition of a connection
    // whatever the caller holds. The further one is the gate above:
    // `requireTypeAccess` refuses a `system.connection` write to every
    // credential the product can mint, since the reserved namespace admits
    // only `is_operator` and an operator key holds no permissions at all.
    //
    // A refusal behind both could never answer, and unreachable enforcement
    // is worse than none because it reads as a protection somebody is relying
    // on. `item-state-doors.test.ts` pins the lifecycle rule and
    // `auth-grant-visibility.test.ts` pins what a caller actually meets.
    const { updated, broughtBack } = await storage.runInTransaction(
      async () => {
        const back =
          item.state === "trashed" && state === "active"
            ? await storage.items.restoreBeneath(id)
            : [];
        return {
          updated: await storage.items.transition(id, state),
          broughtBack: back,
        };
      },
    );
    const metadata = await storage.metadata.get(id);
    await publish({
      type: "state_changed",
      item: updated,
      metadata,
    });
    await publishBroughtBack(storage, broughtBack);
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
