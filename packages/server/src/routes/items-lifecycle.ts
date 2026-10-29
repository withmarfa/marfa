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
import {
  OkResponseSchema,
  createOpenAPIRouter,
  makeErrorResponseSchema,
} from "../openapi.js";
import { ItemWithMetadataSchema } from "./_schemas.js";
import { readableMetadata } from "./_extension-reach.js";
import { StaleVersionSchema } from "./_item-conflict.js";
import { exactItemVersion } from "../storage/conflict.js";
import { previewTrash, trashItems, writeItem } from "../storage/item-write.js";
import { ITEM_NOT_FOUND, WRITE_REFUSED } from "./_item-refusals.js";

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const IdParam = z.object({
  id: z.string().describe("The ID of the item."),
});

/**
 * The IDs a trash or its preview names, each once in the order first named,
 * refused if one is not an item ID.
 */
function namedIds(ids: readonly string[]): string[] {
  for (const id of ids) {
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, `Invalid item ID: ${id}`, {
        field: "ids",
      });
    }
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/** The most items a trash preview lists under each named item. */
export const TRASH_PREVIEW_LIMIT = 100;

/** The most items one trash, or its preview, names. */
export const TRASH_MAX_IDS = 20;

const DigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "digest must be a SHA-256 hash in hex")
  .openapi({
    example: "9f2c1d3b5a7e4f60b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5",
  });

const TrashIdsSchema = z
  .array(z.string())
  .min(1)
  .max(TRASH_MAX_IDS)
  .openapi({ example: ["019537a0-7b80-7000-8000-000000000001"] });

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

const TrashPreviewItemSchema = z
  .object({
    id: z
      .string()
      .describe("The ID of an item you named.")
      .openapi({ example: "019537a0-7b80-7000-8000-000000000001" }),
    type: z
      .string()
      .describe("The item's type.")
      .openapi({ example: "core.project" }),
    version: z.number().int().min(1).describe("The item's version."),
    takes: z
      .array(TrashPreviewEntrySchema)
      .describe(
        `The other items you can read that a cascading edge such as \`parent-of\` would take into the trash with this item, leaves first, at most ${String(TRASH_PREVIEW_LIMIT)}.`,
      ),
    count: z
      .number()
      .int()
      .describe(
        "How many items you can read that trashing this item would move to the trash, the item itself included.",
      ),
    truncated: z
      .literal(true)
      .optional()
      .describe(
        "`true` if `takes` was cut at its limit. Absent when it lists every item.",
      ),
  })
  .describe("An item you named and what trashing it would take with it.")
  .openapi("TrashPreviewItem");

const TrashPreviewSchema = z
  .object({
    items: z
      .array(TrashPreviewItemSchema)
      .describe("Each item you named, once, in the order you named them."),
    count: z
      .number()
      .int()
      .describe(
        "How many items you can read that trashing the named items would move to the trash, each counted once, the named items included.",
      ),
    digest: z
      .string()
      .describe(
        "A SHA-256 hash, in hex, of every item `count` counts with its version, listed or not. It changes if any of them changes, joins or leaves. Pass it to `POST /items/trash` with the same `ids` to trash only what it covers.",
      )
      .openapi({
        example:
          "9f2c1d3b5a7e4f60b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5",
      }),
  })
  .describe(
    "What trashing items would move to the trash. Items you can't read are taken too and aren't listed or counted.",
  )
  .openapi("TrashPreview", {
    example: {
      items: [
        {
          id: "019537a0-7b80-7000-8000-000000000001",
          type: "core.project",
          version: 4,
          takes: [
            {
              id: "019537a0-7b80-7000-8000-000000000002",
              type: "core.task",
              version: 2,
            },
          ],
          count: 2,
        },
      ],
      count: 2,
      digest:
        "9f2c1d3b5a7e4f60b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5",
    },
  });

/** The refusals a trash and its preview share. */
const trashRefusals = {
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
    description:
      "- `item_not_found`: an ID in `ids` names no item, or names an item whose type you can't read. If that item is in the trash and you can read its type, `details.trashed` is `true`.",
  },
} as const;

const trashBadRequest = (extra: string) => ({
  content: {
    "application/json": {
      schema: makeErrorResponseSchema([
        "edge_constraint_violation",
        "invalid_id",
        "missing_required_field",
        "validation_error",
      ]),
    },
  },
  description: `- \`invalid_id\`: an ID in \`ids\` is not an item ID.\n- \`missing_required_field\`: \`ids\` is missing.\n- \`edge_constraint_violation\`: a \`cascade_on_delete: block\` edge holds a named item or one its trash would take.\n- \`validation_error\`: a named item is a live \`system.connection\`, \`ids\` is empty or has over ${String(TRASH_MAX_IDS)} IDs${extra}, or the body has a field this endpoint doesn't take.`,
});

const previewItemTrashRoute = createRoute({
  operationId: "previewItemTrash",
  method: "post",
  path: "/trash-preview",
  tags: ["Items"],
  summary: "Preview trashing items",
  description:
    "Returns what `POST /items/trash` would move to the trash for the same `ids`: each item and every item you can read that a cascading edge such as `parent-of` would take with it. Nothing changes.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.strictObject({
            ids: TrashIdsSchema.describe(
              `The IDs of the items you would trash, at most ${String(TRASH_MAX_IDS)}.`,
            ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: TrashPreviewSchema },
      },
      description: "Returns the items and what their trash would take.",
    },
    400: trashBadRequest(""),
    ...trashRefusals,
  },
});

const trashItemsRoute = createRoute({
  operationId: "trashItems",
  method: "post",
  path: "/trash",
  tags: ["Items"],
  summary: "Trash items",
  description:
    "Moves the items, and every item a cascading edge such as `parent-of` reaches from them, to the trash in one step, all of them or none of them. You can restore them until the retention window ends. Marfa then purges them.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.strictObject({
            ids: TrashIdsSchema.describe(
              `The IDs of the items to trash, at most ${String(TRASH_MAX_IDS)}.`,
            ),
            digest: DigestSchema.optional().describe(
              "The `digest` from `POST /items/trash-preview` for the same `ids`. If what the trash would take has changed since, nothing is trashed. Leave it out to trash what the items take now.",
            ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description:
        'Returns `{ "ok": true }`. An item that a cascading edge took into the trash has `trashed_by_cascade`, and `trashed_with` names the named item that took it if you can read its type.',
    },
    400: trashBadRequest(", `digest` is not a SHA-256 hash in hex"),
    ...trashRefusals,
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["trash_plan_changed"]),
        },
      },
      description:
        "- `trash_plan_changed`: what the trash would take no longer matches `digest`. `details.digest` is the digest now, and nothing is trashed.",
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

  // POST /items/trash-preview
  router.openapi(
    snapshotReadRoute(storage, previewItemTrashRoute),
    async (c) => {
      const ids = namedIds(c.req.valid("json").ids);
      const { roots, count, digest } = await previewTrash(
        storage,
        requireAuth(c),
        ids,
      );
      return c.json(
        {
          items: roots.map(({ row, taken }) => {
            const takes = taken.slice(0, TRASH_PREVIEW_LIMIT).map((item) => ({
              id: item.id,
              type: item.type,
              version: item.version,
            }));
            return {
              id: row.id,
              type: row.type,
              version: row.version,
              takes,
              count: taken.length + 1,
              ...(taken.length > takes.length && { truncated: true as const }),
            };
          }),
          count,
          digest,
        },
        200,
      );
    },
  );

  // POST /items/trash
  router.openapi(trashItemsRoute, async (c) => {
    const body = c.req.valid("json");
    const ids = namedIds(body.ids);
    const { id: keyId } = requireAuth(c);
    await runAuditedTransaction(
      storage,
      () => trashItems(storage, requireAuth(c), ids, body.digest),
      (moves) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: keyId,
        action: "items.trash",
        resource_type: "items.trash",
        details: {
          ids,
          trashed: moves.reduce(
            (sum, move) => sum + move.trashed.length + 1,
            0,
          ),
        },
      }),
      undefined,
      "items.trash",
    );
    return c.json({ ok: true as const }, 200);
  });

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
