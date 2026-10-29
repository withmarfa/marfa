import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { snapshotReadRoute } from "../middleware/read-snapshot.js";
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
import { previewTrash, writeItem } from "../storage/item-write.js";
import {
  ITEM_NOT_FOUND,
  ITEM_NOT_FOUND_ON_WRITE,
  WRITE_REFUSED,
} from "./_item-refusals.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string().describe("The ID of the item."),
});

/** The IDs `check_ids` names, each once, or undefined if it is absent. */
function checkedIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    ),
  ];
  if (ids.length > TRASH_PREVIEW_CHECK_LIMIT) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `check_ids names more than ${String(TRASH_PREVIEW_CHECK_LIMIT)} IDs`,
      { field: "check_ids" },
    );
  }
  for (const id of ids) {
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, `Invalid item ID: ${id}`, {
        field: "check_ids",
      });
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/** The most items a trash preview lists beside the item itself. */
export const TRASH_PREVIEW_LIMIT = 100;

/** The most IDs a trash preview checks with `check_ids`. */
export const TRASH_PREVIEW_CHECK_LIMIT = 20;

/**
 * A SHA-256 over every item a trash would take that the key may read, each
 * as its ID and version, in ID order: equal for two previews only if the
 * same items at the same versions would go.
 */
const TrashPreviewEntrySchema = z
  .object({
    id: z
      .string()
      .describe("Unique identifier for the item.")
      .openapi({ example: "019537a0-7b80-7000-8000-000000000002" }),
    type: z
      .string()
      .describe("The item's type.")
      .openapi({ example: "core.task" }),
    version: z.number().int().min(1).describe("The item's version."),
  })
  .describe("An item that trashing another item would take with it.")
  .openapi("TrashPreviewEntry");

const TrashPreviewSchema = z
  .object({
    id: z
      .string()
      .describe("The ID of the item you would trash.")
      .openapi({ example: "019537a0-7b80-7000-8000-000000000001" }),
    type: z
      .string()
      .describe("The item's type.")
      .openapi({ example: "core.project" }),
    version: z
      .number()
      .int()
      .min(1)
      .describe(
        "The item's version. Pass it as `version` to `DELETE /items/{id}` to trash the item only if it is unchanged.",
      ),
    items: z
      .array(TrashPreviewEntrySchema)
      .describe(
        `The other items you can read that a cascading edge such as \`parent-of\` would take into the trash, leaves first, at most ${String(TRASH_PREVIEW_LIMIT)}.`,
      ),
    count: z
      .number()
      .int()
      .describe(
        "How many items you can read that trashing the item would move to the trash, the item itself included.",
      ),
    truncated: z
      .literal(true)
      .optional()
      .describe(
        "`true` if `items` was cut at its limit. Absent when it lists every item.",
      ),
    digest: z
      .string()
      .describe(
        "A SHA-256 hash, in hex, of every item `count` counts with its version, listed or not. It changes if any of them changes, joins or leaves. Pass it to `DELETE /items/{id}` to trash only what it covers.",
      )
      .openapi({
        example:
          "9f2c1d3b5a7e4f60b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5",
      }),
    taken_ids: z
      .array(z.string())
      .optional()
      .describe(
        "The IDs in `check_ids` that trashing the item would move to the trash, in the order you named them. Present only if you send `check_ids`.",
      ),
  })
  .describe(
    "What trashing an item would move to the trash. Items you can't read are taken too and aren't listed or counted.",
  )
  .openapi("TrashPreview", {
    example: {
      id: "019537a0-7b80-7000-8000-000000000001",
      type: "core.project",
      version: 4,
      items: [
        {
          id: "019537a0-7b80-7000-8000-000000000002",
          type: "core.task",
          version: 2,
        },
      ],
      count: 2,
      digest:
        "9f2c1d3b5a7e4f60b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5",
    },
  });

const previewItemTrashRoute = createRoute({
  operationId: "previewItemTrash",
  method: "get",
  path: "/{id}/trash-preview",
  tags: ["Items"],
  summary: "Preview trashing an item",
  description:
    "Returns what `DELETE /items/{id}` would move to the trash: the item and every item you can read that a cascading edge such as `parent-of` would take with it. Nothing changes.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    query: z.object({
      check_ids: z
        .string()
        .optional()
        .describe(
          `Other item IDs, comma-separated, at most ${String(TRASH_PREVIEW_CHECK_LIMIT)}. \`taken_ids\` answers which of them trashing the item would move to the trash.`,
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: TrashPreviewSchema },
      },
      description: "Returns the item and what its trash would take.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_constraint_violation",
            "invalid_id",
            "validation_error",
          ]),
        },
      },
      description: `- \`invalid_id\`: the ID, or one in \`check_ids\`, is not a valid item ID.\n- \`edge_constraint_violation\`: an edge type on the item has \`cascade_on_delete: block\`, and such an edge exists, so a delete would be refused.\n- \`validation_error\`: the item is a live \`system.connection\`, or \`check_ids\` names more than ${String(TRASH_PREVIEW_CHECK_LIMIT)} IDs.`,
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
      description: ITEM_NOT_FOUND_ON_WRITE,
    },
  },
});

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

  // GET /items/:id/trash-preview
  router.openapi(
    snapshotReadRoute(storage, previewItemTrashRoute),
    async (c) => {
      const { id } = c.req.valid("param");
      if (!isValidId(id)) {
        throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
      }
      const checkIds = checkedIds(c.req.valid("query").check_ids);
      const { row, taken, digest } = await previewTrash(
        storage,
        requireAuth(c),
        id,
      );
      const takenIds = new Set(taken.map((item) => item.id));
      const items = taken.slice(0, TRASH_PREVIEW_LIMIT).map((item) => ({
        id: item.id,
        type: item.type,
        version: item.version,
      }));
      return c.json(
        {
          id: row.id,
          type: row.type,
          version: row.version,
          items,
          count: taken.length + 1,
          ...(taken.length > items.length && { truncated: true as const }),
          digest,
          ...(checkIds !== undefined && {
            taken_ids: checkIds.filter((checked) => takenIds.has(checked)),
          }),
        },
        200,
      );
    },
  );

  // POST /items/:id/restore
  router.openapi(restoreItemRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const { id: keyId } = requireAuth(c);
    // The move, its events and what the answer reads, in one transaction,
    // with the key as it stands there.
    const { key, restored, metadata } = await runAuditedTransaction(
      storage,
      async () => {
        const key = requireAuth(c);
        const { item: restored } = await writeItem(
          storage,
          { kind: "credential", key },
          { op: "restore", id },
        );
        return { key, restored, metadata: await storage.metadata.get(id) };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: keyId,
        action: "item.restore",
        resource_type: "item",
        resource_id: id,
      },
    );

    return c.json(
      {
        item: restored,
        metadata: readableMetadata(metadata, key),
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

    requireAuth(c);
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
        const key = requireAuth(c);
        const { item: updated, from } = await writeItem(
          storage,
          { kind: "credential", key },
          { op: "transition", id, state },
        );
        return {
          key,
          updated,
          from,
          metadata: await storage.metadata.get(id),
        };
      },
      (result) =>
        "conflict" in result
          ? null
          : {
              client_ip: c.get("clientIp") ?? null,
              key_id: result.key.id,
              action: "item.transition",
              resource_type: "item",
              resource_id: id,
              details: { from_state: result.from, to_state: state },
            },
      undefined,
      "item.transition",
    );

    if ("conflict" in result) {
      c.header("X-Error-Code", "version_conflict");
      return c.json(result.conflict, 409);
    }
    return c.json(
      {
        item: result.updated,
        metadata: readableMetadata(result.metadata, result.key),
      },
      200,
    );
  });

  return router;
}
