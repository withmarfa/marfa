import { runAuditedTransaction } from "../storage/audited-transaction.js";
/**
 * Operator surface for shipped types an instance still carries that its
 * build no longer names.
 *
 * The seed is an upsert with no prune, so deleting a type's JSON removes it
 * from a fresh instance and from no existing one. The row keeps resolving
 * and the immutability gate refuses to delete it, because everything in the
 * platform set is locked. Removing one was a hand-written migration,
 * guarded on item count, and the next retirement needed it written again.
 *
 * **The listing reports and the delete is one explicit act**, which is the
 * whole shape. A prune beside the seed would fire hardest exactly when the
 * build is wrong: the shipped set is a committed generated array, so a
 * partial deploy cannot ship fewer types, and the realistic population is a
 * rollback, where the older build simply does not know about rows the newer
 * one wrote. Deleting those on every container on every restart, with
 * nobody present, is not a tidy-up.
 *
 * **A migration cannot fill this hole, which is the argument for a route at
 * all.** A migration runs once per instance. The retirement that prompted
 * this declined on instances still holding items, and the journal marked it
 * applied regardless, so those instances are permanently divergent with no
 * path back short of a second migration authored for them specifically.
 *
 * Shaped after the dead-letter surface: the listing is bulk, the action
 * names one item, and a state it cannot act on is a 409 rather than a
 * silent no-op.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { wholeListOf } from "./_schemas.js";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { operatorOnly } from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import type { Storage } from "../storage/interface.js";
import { platformDrift } from "../storage/platform-drift.js";

const DriftedTypeSchema = z
  .object({
    id: z.string().describe("The identifier of the stale type."),
    item_count: z
      .number()
      .describe("How many items carry this type, counted when you ask."),
    child_types: z
      .array(z.string())
      .describe("The types that name this one as their `parent`."),
    removable: z
      .boolean()
      .describe(
        "`true` if `DELETE /platform-types/{id}` would remove the type: no item carries it and no type inherits from it.",
      ),
  })
  .describe("A platform type that this build no longer ships.")
  .openapi("DriftedPlatformType");

const listDriftRoute = createRoute({
  operationId: "listPlatformTypeDrift",
  method: "get",
  path: "/drift",
  // Filed under the type registry, which is what a drifted row is a row of.
  // Both operations here published no tag at all, so they were the only two
  // in the reference that belonged to no heading.
  tags: ["Types"],
  summary: "List stale platform types",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  description:
    "Returns the platform types that this instance still carries but this build no longer ships, with how many items use each. They stay in `GET /types` until removed. Operator key only.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(
            DriftedTypeSchema,
            "DriftedPlatformTypePage",
            "stale type",
          ),
        },
      },
      description:
        "Returns the stale types. A type deleted since the server started stays listed, with `removable: true`, until it restarts.",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "`forbidden`: you aren't using the operator key.",
    },
  },
});

const deletePlatformTypeRoute = createRoute({
  operationId: "deletePlatformType",
  method: "delete",
  path: "/{id}",
  tags: ["Types"],
  summary: "Delete a stale platform type",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  description:
    "Deletes one platform type that this build no longer ships. The type stops resolving at once. Operator key only.",
  request: {
    params: z.object({
      id: z.string().describe("The identifier of the stale type to delete."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ removed: z.literal(true), id: z.string() }),
        },
      },
      description: "Returns `removed: true` and the type's `id`.",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "`forbidden`: you aren't using the operator key.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found", "type_not_found"]),
        },
      },
      description:
        "- `type_not_found`: no platform type has this identifier.\n- `not_found`: the type was deleted after the server started.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description:
        "`conflict`: the type isn't one this build stopped shipping, items still carry it, or another type inherits from it (`details.child_types` lists them).",
    },
  },
});

/**
 * Types that name `id` as their parent.
 *
 * **A parent supplies fields to its children, not items.** An abstract
 * parent carries no items of its own by construction, so the item count is
 * zero for exactly the types whose removal does the most damage: the
 * shipped set has seven types under `core.media` alone. Removing one would
 * leave every child resolving with the inherited half of its field set
 * gone, silently, because ancestor collection degrades to a partial view
 * on an unresolvable parent rather than failing.
 *
 * Read from the rows rather than the in-memory registry so a registration
 * this instance wrote that inherits from a platform type is counted too.
 */
async function declaredChildrenOf(
  storage: Storage,
  id: string,
): Promise<string[]> {
  const rows = await storage.types.loadAll();
  return rows
    .filter((row) => row.schema.parent === id)
    .map((row) => row.schema.id)
    .sort();
}

export function platformTypeRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listDriftRoute, async (c) => {
    const ids = platformDrift();
    const types = await Promise.all(
      ids.map(async (id) => {
        const itemCount = await storage.items.countByType(id);
        const children = await declaredChildrenOf(storage, id);
        return {
          id,
          item_count: itemCount,
          child_types: children,
          removable: itemCount === 0 && children.length === 0,
        };
      }),
    );
    return c.json({ data: types, next_cursor: null }, 200);
  });

  router.openapi(deletePlatformTypeRoute, async (c) => {
    const { id } = c.req.valid("param");

    // Asked of this boot's derived set rather than of the row, and the
    // difference is the guard: a row exists for every shipped type too, so
    // testing existence alone would make this able to remove a live one.
    if (!platformDrift().includes(id)) {
      // **Two refusals, told apart by whether there is a row at all.** An
      // identifier nothing carries is absent, which is `404`, and one a
      // row does carry is present and not removable here, which is a
      // statement about its state and stays `409`. Answering both `409`
      // sent a caller looking for a row to move out of the way when the
      // thing it named had never existed.
      const rows = await storage.types.loadAll();
      const carried = rows.some((row) => row.schema.id === id);
      throw new MarfaError(
        carried ? ErrorCode.CONFLICT : ErrorCode.TYPE_NOT_FOUND,
        carried
          ? `"${id}" is not a type this build has stopped shipping, so it cannot be removed here`
          : `No platform row carries "${id}"`,
        { type: id },
      );
    }

    // The count, the children and the delete are one transaction, as the
    // ordinary type delete's are: the store takes the type out of the
    // registry before it commits, and an item create asks the registry
    // inside its own transaction, so an item written meanwhile either lands
    // first and is counted or comes after and is refused.
    await runAuditedTransaction(
      storage,
      async () => {
        // Recomputed, never the listing's copy. This is the one part of the
        // report that changes without a restart, and a removal reasoning from
        // a stale count is the failure this route exists to avoid.
        const itemCount = await storage.items.countByType(id);
        if (itemCount > 0) {
          throw new MarfaError(
            ErrorCode.CONFLICT,
            `${String(itemCount)} item(s) still carry "${id}". The row is what makes them resolve, so it stays registered until they move.`,
            { type: id, item_count: itemCount },
          );
        }

        // Asked after the item count and before the write, because it is the
        // guard the item count cannot stand in for: the types most certain to
        // report zero items are the abstract parents.
        const children = await declaredChildrenOf(storage, id);
        if (children.length > 0) {
          throw new MarfaError(
            ErrorCode.CONFLICT,
            `${String(children.length)} type(s) inherit from "${id}": ${children.join(", ")}. Removing it would leave them resolving without the fields they inherit.`,
            { type: id, child_types: children },
          );
        }

        const removed = await storage.types.deletePlatformType(id);
        if (!removed) {
          throw new MarfaError(
            ErrorCode.NOT_FOUND,
            `No platform row for "${id}"`,
            { type: id },
          );
        }
      },
      {
        action: "platform_type.removed",
        resource_type: "type",
        resource_id: id,
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        details: { type: id },
      },
    );

    return c.json({ removed: true as const, id }, 200);
  });

  return router;
}
