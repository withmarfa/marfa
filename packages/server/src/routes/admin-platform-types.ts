/**
 * Operator surface for shipped types an instance still carries that its
 * build no longer names.
 *
 * The seed is an upsert with no prune, so deleting a type's JSON removes it
 * from a fresh instance and from no existing one. The row keeps resolving
 * and the immutability gate refuses to delete it, because everything in the
 * platform set is locked. Removing one was a hand-written migration on both
 * dialects, guarded on item count, and the next retirement needed it
 * written again.
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
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import type { Storage } from "../storage/interface.js";
import { platformDrift } from "../storage/platform-drift.js";

const DriftedTypeSchema = z.object({
  id: z.string(),
  /** Items carrying this identifier, across every space. */
  item_count: z.number(),
  /** Whether a delete would be declined because items still hold it. */
  removable: z.boolean(),
});

const listDriftRoute = createRoute({
  operationId: "adminListPlatformTypeDrift",
  method: "get",
  path: "/platform-types/drift",
  summary: "Shipped types this instance carries that the build does not",
  description:
    "Lists platform type rows this instance still carries that the running build no longer ships, each with how many items across every space still carry the identifier. `/health` publishes the count of these as the `platform_types` component; this is where the identifiers live, because that endpoint is unauthenticated. The count is read live rather than cached at boot: it is the part that changes without a restart, and a removal reasoning from a stale copy is the failure worth avoiding. Platform-admin only.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ types: z.array(DriftedTypeSchema) }),
        },
      },
      description: "The drifted rows, with their live item counts",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not a platform admin",
    },
  },
});

const removeDriftedTypeRoute = createRoute({
  operationId: "adminRemovePlatformType",
  method: "post",
  path: "/platform-types/{id}/remove",
  summary: "Remove one shipped type the build no longer carries",
  description:
    "Removes exactly one platform type row this build does not ship. Refused with `409` when the identifier is one the build still ships, so this can never remove a live type, and refused with `409` when items still carry it: the row is what makes those items resolve, and orphaning readable data to tidy a registry is the wrong trade. The item count is recomputed inside the request rather than read from the boot-time report. The type stops resolving on the next restart, since the in-memory registry is filled from the rows at boot. Platform-admin only.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ removed: z.literal(true), id: z.string() }),
        },
      },
      description: "The row is gone",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not a platform admin",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "No platform row with this identifier",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description:
        "The build still ships this type, or items still carry the identifier",
    },
  },
});

export function adminPlatformTypeRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listDriftRoute, async (c) => {
    requireAdmin(c);
    const ids = platformDrift();
    const types = await Promise.all(
      ids.map(async (id) => {
        const itemCount = await storage.items.countByType(id);
        return { id, item_count: itemCount, removable: itemCount === 0 };
      }),
    );
    return c.json({ types }, 200);
  });

  router.openapi(removeDriftedTypeRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");

    // Asked of this boot's derived set rather than of the row, and the
    // difference is the guard: a row exists for every shipped type too, so
    // testing existence alone would make this able to remove a live one.
    if (!platformDrift().includes(id)) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `"${id}" is not a type this build has stopped shipping, so it cannot be removed here`,
        { type: id },
      );
    }

    // Recomputed, never the listing's copy. This is the one part of the
    // report that changes without a restart, and a removal reasoning from a
    // stale count is the failure this route exists to avoid.
    const itemCount = await storage.items.countByType(id);
    if (itemCount > 0) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `${String(itemCount)} item(s) still carry "${id}". The row is what makes them resolve, so it stays registered until they move.`,
        { type: id, item_count: itemCount },
      );
    }

    const removed = await storage.types.deletePlatformType(id);
    if (!removed) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `No platform row for "${id}"`, {
        type: id,
      });
    }
    return c.json({ removed: true as const, id }, 200);
  });

  return router;
}
