import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  readsSomeType,
  requireReadableRow,
  requireTypeAccess,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ItemWithMetadataSchema } from "./_schemas.js";
import { readableMetadata } from "./_extension-reach.js";
import { StaleVersionSchema } from "./_item-conflict.js";
import { exactItemVersion } from "../storage/conflict.js";
import { writeItem } from "../storage/item-write.js";
import { ITEM_NOT_FOUND, WRITE_REFUSED } from "./_item-refusals.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string().describe("The ID of the item."),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const restoreItemRoute = createRoute({
  operationId: "restoreItem",
  method: "post",
  path: "/{id}/restore",
  tags: ["Items"],
  summary: "Restore an item",
  description:
    "Restores a trashed item to `active`, along with every item its trash took through a cascading edge such as `parent-of`. Items that were already in the trash before then stay there.",
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
      description: "Returns the restored item and its metadata.",
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
        "- `invalid_id`: the ID is not a valid item ID.\n- `invalid_transition`: the item is not in the trash.\n- `validation_error`: `Idempotency-Key` is malformed.",
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
  summary: "Change an item's state",
  description:
    "Moves the item to `active`, `archived` or `trashed`. Moving to `trashed` deletes the item as `DELETE /items/{id}` does, and moving from `trashed` to `active` restores it as `POST /items/{id}/restore` does.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    query: z.object({
      version: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The item version you read. If it differs, nothing moves. Leave it out to move the item as it is.",
        ),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.strictObject({
            state: z
              .enum(["active", "archived", "trashed"])
              .describe("The state to move the item to."),
          }),
        },
      },
    },
  },
  responses: {
    409: {
      content: { "application/json": { schema: StaleVersionSchema } },
      description:
        "`version_conflict`: `version` differs from the item. `current` is the item now; nothing moved.",
    },
    200: {
      content: {
        "application/json": { schema: ItemWithMetadataSchema },
      },
      description: "Returns the item in its new state, with its metadata.",
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
        "- `invalid_transition`: the type's lifecycle doesn't allow the move, such as `trashed` to `archived`. Restore first.\n- `edge_constraint_violation`: a `block` edge holds an item that a move to `trashed` would take.\n- `validation_error`: `state` is invalid, or the body has a field this endpoint doesn't take.\n- `missing_required_field`: `state` is missing.\n- `invalid_id`: the ID is not valid.",
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
          schema: makeErrorResponseSchema(["item_not_found", "edge_not_found"]),
        },
      },
      description: `${ITEM_NOT_FOUND}\n- \`edge_not_found\`: a repeat under the \`Idempotency-Key\` would show an edge you can no longer read.`,
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
    const { version } = c.req.valid("query");
    // body.state is constrained to the lifecycle enum by the route Zod;
    // typeof / truthiness check would be unreachable.

    const key = requireAuth(c);
    // Read past the trash, so a transition out of it is judged by the type's
    // graph: `trashed` admits `active` alone. A move into the bin takes what
    // a delete takes and is held by what holds a delete.
    const result = await runAuditedTransaction(
      storage,
      async () => {
        const row = requireReadableRow(
          c,
          await storage.items.getIncludingTrashed(id),
          () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found"),
        );
        requireTypeAccess(c, row, "write");
        const conflict = exactItemVersion(row, version);
        if (conflict) return { conflict };
        const { item: updated, from } = await writeItem(
          storage,
          { kind: "credential", key },
          { op: "transition", id, state },
        );
        return { updated, from, metadata: await storage.metadata.get(id) };
      },
      (result) =>
        "conflict" in result
          ? null
          : {
              client_ip: c.get("clientIp") ?? null,
              key_id: c.get("apiKey")?.id,
              action: "item.transition",
              resource_type: "item",
              resource_id: id,
              details: { from_state: result.from, to_state: state },
            },
    );

    if ("conflict" in result) {
      c.header("X-Error-Code", "version_conflict");
      return c.json(result.conflict, 409);
    }
    return c.json(
      {
        item: result.updated,
        metadata: readableMetadata(result.metadata, c.get("apiKey")),
      },
      200,
    );
  });

  return router;
}
