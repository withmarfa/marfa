import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { ITEM_NOT_FOUND, WRITE_REFUSED } from "./_item-refusals.js";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, readsSomeType } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ItemWithMetadataSchema } from "./_schemas.js";
import { readableMetadata } from "./_extension-reach.js";
import { writeItem } from "../storage/item-write.js";

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
    "Restores a trashed item to active, and with it every row its trash took through a cascading edge such as `parent-of`, each announced `item.restored` with `restored_with` naming this item to a subscriber that may read its type; a row that was already in the bin when it was trashed stays there. Trashed items are auto-purged after the retention window, so a restore only succeeds while the row still exists.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
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
      description: WRITE_REFUSED,
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

const transitionItemRoute = createRoute({
  operationId: "transitionItem",
  method: "post",
  path: "/{id}/transition",
  tags: ["Items"],
  summary: "Transition item state",
  description:
    "Moves the item to the supplied lifecycle state. Going straight from trashed to archived is rejected — restore to active first. A move into trashed is a delete: it takes every row a cascading edge reaches, each announced `item.deleted` with the mark a delete gives it, and is refused `400 edge_constraint_violation` by a `block` edge as a delete is. A move from trashed to active brings back every row the item's trash took through a cascading edge, as a restore does, each announced `item.restored` with `restored_with` naming this item to a subscriber that may read its type.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
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
            "edge_constraint_violation",
          ]),
        },
      },
      description:
        "`invalid_transition`: the type's lifecycle does not allow the move. `edge_constraint_violation`: a `block` edge holds a row a move into trashed would take.",
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
      description: WRITE_REFUSED,
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

export function itemsLifecycleRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /items/:id/restore
  router.openapi(restoreItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const key = requireAuth(c);
    // The move, its events and what the answer reads, in one transaction.
    const { restored, metadata } = await runAuditedTransaction(
      storage,
      async () => {
        const { item: restored } = await writeItem(
          storage,
          { kind: "credential", key },
          { op: "restore", id },
        );
        return { restored, metadata: await storage.metadata.get(id) };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "item.restore",
        resource_type: "item",
        resource_id: id,
      },
    );

    return c.json(
      {
        item: restored,
        metadata: readableMetadata(metadata, c.get("apiKey")),
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

    const key = requireAuth(c);
    // Read past the trash, so a transition out of it is judged by the type's
    // graph: `trashed` admits `active` alone. A move into the bin takes what
    // a delete takes and is held by what holds a delete.
    const { updated, metadata } = await runAuditedTransaction(
      storage,
      async () => {
        const { item: updated, from } = await writeItem(
          storage,
          { kind: "credential", key },
          { op: "transition", id, state },
        );
        return { updated, from, metadata: await storage.metadata.get(id) };
      },
      ({ from }) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "item.transition",
        resource_type: "item",
        resource_id: id,
        details: { from_state: from, to_state: state },
      }),
    );

    return c.json(
      {
        item: updated,
        metadata: readableMetadata(metadata, c.get("apiKey")),
      },
      200,
    );
  });

  return router;
}
