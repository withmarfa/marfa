import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  isValidId,
  isValidTypeIdentifier,
  type Item,
} from "@withmarfa/shared";
import type { Context } from "hono";
import { requestWriter } from "../auth/version-writer.js";
import type { AppConfig } from "../config.js";
import {
  authorityId,
  directAuthorityOnly,
  requireRecentOwnerAuthentication,
  type AppEnv,
} from "../middleware/auth.js";
import { snapshotReadRoute } from "../middleware/read-snapshot.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { pageCursor, pageLimit } from "../page-limits.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { writeItem } from "../storage/item-write.js";
import type { ItemSummary, Storage } from "../storage/interface.js";
import { nameOf } from "../storage/part-names.js";
import { ItemSummarySchema, summaryFilters } from "./item-summaries.js";
import { pageOf, VersionWriterSchema } from "./_schemas.js";
import { isWriteOutcomeUnknown } from "./_bulk-rollback.js";
import { trashEligibleAt } from "../trash-retention.js";
import { setNoStore } from "./no-store.js";

export const TrashSummarySchema = ItemSummarySchema.extend({
  eligible_for_deletion_at: z
    .string()
    .nullable()
    .describe(
      "When automatic deletion becomes eligible under the effective policy, or null when disabled or the date is unknown. The sweep may delete it later.",
    ),
  trashed_at: z
    .string()
    .nullable()
    .describe("When the item entered the trash, or null if not recorded."),
  trashed_by: VersionWriterSchema.nullable().describe(
    "The sign-in that moved the item to the trash, captured at that time, or null if not recorded.",
  ),
})
  .describe("A trashed item’s summary and recorded deletion identity.")
  .openapi("TrashSummary");
const cursorQuery = z.object({
  type: z
    .string()
    .refine(isValidTypeIdentifier, "Expected a type identifier")
    .optional()
    .describe("Only return items of this exact type."),
  q: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Only return item names containing this text, ignoring case and surrounding whitespace.",
    ),
  cursor: pageCursor(),
  limit: pageLimit({ max: 200, default: 25 }),
});
const refusal = {
  content: {
    "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
  },
  description:
    "`forbidden`: requires direct owner or local authority, and a recent sign-in for changes.",
};
const listRoute = createRoute({
  method: "get",
  path: "/trash",
  operationId: "listTrash",
  tags: ["Trash"],
  summary: "List the trash",
  description:
    "Returns a page of trash summaries, newest creation first, without item content. Only the owner or a local command can use this operation.",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  request: { query: cursorQuery },
  responses: {
    200: {
      description:
        "Returns trash summaries and the effective retention in days. Zero disables automatic expiry.",
      content: {
        "application/json": {
          schema: pageOf(TrashSummarySchema, "TrashSummaryPage", {
            page: "A page of trashed item summaries.",
            data: "The trashed items on this page.",
          })
            .extend({
              retention_days: z
                .number()
                .int()
                .describe(
                  "How many days after deletion an item becomes eligible for automatic expiry; zero disables expiry.",
                ),
            })
            .openapi("TrashPage"),
        },
      },
    },
    400: {
      description: "`validation_error`: invalid page or cursor.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
    },
    403: refusal,
  },
});
const changeResponses = {
  500: {
    description:
      "`internal_error`: the result could not be confirmed; when details.write_outcome is unknown, refresh before retrying.",
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["internal_error"]),
      },
    },
  },
  200: {
    description: "The action completed. Returns only the item summary.",
    content: { "application/json": { schema: ItemSummarySchema } },
  },
  400: {
    description:
      "- `invalid_id`: the item ID is invalid.\n- `validation_error`: the version is invalid or a live connection prevents the change.\n- `invalid_transition`: the item is no longer in the required state.\n- `edge_constraint_violation`: a cascading edge blocks the change.",
    content: {
      "application/json": {
        schema: makeErrorResponseSchema([
          "invalid_id",
          "validation_error",
          "invalid_transition",
          "edge_constraint_violation",
        ]),
      },
    },
  },
  403: refusal,
  404: {
    description:
      "`item_not_found`: the item is absent or not in the owner's item listing.",
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["item_not_found"]),
      },
    },
  },
  409: {
    description:
      "`version_conflict`: the item changed. The current value is a summary, without content.",
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["version_conflict"])
          .extend({
            current: ItemSummarySchema.describe(
              "The item summary now, without content.",
            ),
          })
          .openapi("ItemSummaryConflict"),
      },
    },
  },
};
const changeRequest = {
  params: z.object({ id: z.string().describe("The ID of the item.") }),
  query: z.object({
    version: z.coerce
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .describe(
        "The item version from the summary listing. If it differs, nothing changes.",
      ),
  }),
};
const trashRoute = createRoute({
  method: "post",
  path: "/items/summaries/{id}/trash",
  operationId: "trashItemSummary",
  tags: ["Trash"],
  summary: "Trash an item by summary",
  description:
    "Moves the item and its cascading children to the trash. Returns only a summary. Requires the version from the listing.",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  request: changeRequest,
  responses: changeResponses,
});
const restoreRoute = createRoute({
  method: "post",
  path: "/items/summaries/{id}/restore",
  operationId: "restoreItemSummary",
  tags: ["Trash"],
  summary: "Restore an item by summary",
  description:
    "Restores the item and the children its trash took. Returns only a summary. Requires the version from the listing.",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  request: changeRequest,
  responses: changeResponses,
});
const purgeRoute = createRoute({
  method: "post",
  path: "/items/summaries/{id}/purge",
  operationId: "purgeItemSummary",
  tags: ["Trash"],
  summary: "Purge an item by summary",
  description:
    "Purges one item, deleting it permanently, if it is still in the trash at the listed version. Returns only a summary.",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  request: changeRequest,
  responses: changeResponses,
});
const emptyRoute = createRoute({
  method: "post",
  path: "/trash/empty",
  operationId: "emptyTrash",
  tags: ["Trash"],
  summary: "Empty the trash",
  description:
    "Empties one page of the trash: deletes up to 200 items permanently if their state and version still match. Returns partial results and a continuation cursor. Items trashed during the operation may remain.",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  request: { query: z.object({ cursor: pageCursor() }) },
  responses: {
    200: {
      description:
        "Returns the committed purge count, per-item failures and the next batch cursor. Unknown write outcomes carry `details.write_outcome: unknown` and stop this batch; refresh before retrying. Other failures leave the item in place.",
      content: {
        "application/json": {
          schema: z.object({
            purged: z
              .number()
              .int()
              .describe("The number of items this batch permanently deleted."),
            failures: z
              .array(
                z
                  .object({
                    id: z
                      .string()
                      .describe(
                        "The ID of the item whose purge failed or could not be confirmed.",
                      ),
                    code: z
                      .string()
                      .describe(
                        "The code describing the failure or uncertain outcome.",
                      ),
                    details: z
                      .object({
                        write_outcome: z
                          .literal("unknown")
                          .describe(
                            "The purge may have committed. Refresh before retrying.",
                          ),
                      })
                      .optional()
                      .describe(
                        "Present when the write outcome cannot be confirmed.",
                      ),
                    message: z
                      .string()
                      .describe(
                        "A summary of the failure without item content.",
                      ),
                  })
                  .describe("One failed or unconfirmed purge."),
              )
              .describe("Failed or unconfirmed purges."),
            next_cursor: z
              .string()
              .nullable()
              .describe(
                "The cursor for the next batch, or null when this traversal ended or stopped on an unknown outcome.",
              ),
          }),
        },
      },
    },
    400: {
      description: "`validation_error`: invalid cursor.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
    },
    403: refusal,
  },
});

async function summary(storage: Storage, row: Item): Promise<ItemSummary> {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    name: nameOf(
      row,
      (await storage.items.partHosts([row.id])).get(row.id),
      () => true,
    ),
    source: row.source,
    created_at: row.created_at,
  };
}
function safeFailure(error: unknown): {
  code: string;
  message: string;
  details?: { write_outcome: "unknown" };
} {
  if (
    isWriteOutcomeUnknown(error) ||
    (error instanceof MarfaError && error.details?.write_outcome === "unknown")
  )
    return {
      code: "internal_error",
      message:
        "The change may have completed, but its result could not be confirmed. Refresh the page before trying again.",
      details: { write_outcome: "unknown" },
    };
  const code = error instanceof MarfaError ? error.code : "internal_error";
  const message =
    code === ErrorCode.INVALID_TRANSITION
      ? "This item is no longer in the required state. Refresh the page."
      : code === ErrorCode.EDGE_CONSTRAINT_VIOLATION
        ? "Another item prevents this item from moving to the trash."
        : code === ErrorCode.ITEM_NOT_FOUND
          ? "This item is no longer available."
          : "The change could not be completed. Refresh the page before trying again.";
  return { code, message };
}
async function visibleRow(storage: Storage, id: string) {
  const row = (
    await storage.items.getMany([id], {
      includeTrashed: true,
      ...(await summaryFilters(storage)),
    })
  ).get(id);
  if (!row || row.type.startsWith("system."))
    throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
  return row;
}
export async function trashRetention(storage: Storage, config: AppConfig) {
  return (
    (await readInstanceConfig(storage.settings))?.trash_retention_days ??
    config.trashRetentionDays
  );
}
export function ownerTrashRoutes(storage: Storage, config: AppConfig) {
  const router = createOpenAPIRouter<AppEnv>();
  router.openapi(snapshotReadRoute(storage, listRoute), async (c) => {
    setNoStore(c);
    const days = await trashRetention(storage, config);
    const page = await storage.items.listTrashSummaries({
      ...c.req.valid("query"),
      ...(await summaryFilters(storage)),
    });
    return c.json(
      {
        ...page,
        data: page.data.map((row) => ({
          ...row,
          eligible_for_deletion_at: trashEligibleAt(row.trashed_at, days),
        })),
        retention_days: days,
      },
      200,
    );
  });
  const change = async (
    c: Context<AppEnv>,
    id: string,
    version: number,
    op: "delete" | "restore" | "purge",
  ) => {
    setNoStore(c);
    requireRecentOwnerAuthentication(c);
    if (!isValidId(id))
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    try {
      return await runAuditedTransaction(
        storage,
        async () => {
          const row = await visibleRow(storage, id);
          if (row.version !== version)
            return { stale: true as const, current: await summary(storage, row) };
          await writeItem(
            storage,
            { kind: "platform", by: requestWriter(c) },
            { op, id },
          );
          return { stale: false as const, current: await summary(storage, row) };
        },
        (result) =>
          result.stale
            ? null
            : {
                action: op === "delete" ? "item.delete" : `item.${op}`,
                key_id: authorityId(c),
                client_ip: c.get("clientIp") ?? null,
                resource_type: "item",
                resource_id: id,
              },
      );
    } catch (error) {
      if (isWriteOutcomeUnknown(error)) throw error;
      if (!(error instanceof MarfaError)) throw error;
      const safe = safeFailure(error);
      throw new MarfaError(error.code, safe.message, safe.details);
    }
  };
  for (const [route, op] of [
    [trashRoute, "delete"],
    [restoreRoute, "restore"],
    [purgeRoute, "purge"],
  ] as const) {
    router.openapi(route, async (c) => {
      let result;
      try {
        result = await change(
          c,
          c.req.valid("param").id,
          c.req.valid("query").version,
          op,
        );
      } catch (error) {
        if (!isWriteOutcomeUnknown(error)) throw error;
        c.header("X-Error-Code", "internal_error");
        return c.json(
          { error: { ...safeFailure(error), code: "internal_error" as const } },
          500,
        );
      }
      if (result.stale) {
        c.header("X-Error-Code", "version_conflict");
        return c.json(
          {
            error: {
              code: "version_conflict" as const,
              message:
                "This item changed. Refresh the page before trying again.",
            },
            current: result.current,
          },
          409,
        );
      }
      return c.json(result.current, 200);
    });
  }
  router.openapi(emptyRoute, async (c) => {
    setNoStore(c);
    requireRecentOwnerAuthentication(c);
    const page = await storage.runInReadSnapshot(
      async () =>
        storage.items.listTrashSummaries({
          ...c.req.valid("query"),
          limit: 200,
          ...(await summaryFilters(storage)),
        }),
      { signal: c.req.raw.signal },
    );
    let purged = 0;
    const failures: ({ id: string } & ReturnType<typeof safeFailure>)[] = [];
    let uncertain = false;
    for (const row of page.data) {
      try {
        const result = await change(c, row.id, row.version, "purge");
        if (result.stale)
          failures.push({
            id: row.id,
            code: "version_conflict",
            message: "This item changed and was kept.",
          });
        else purged++;
      } catch (error) {
        const failure = safeFailure(error);
        failures.push({ id: row.id, ...failure });
        if (failure.details?.write_outcome === "unknown") {
          uncertain = true;
          break;
        }
      }
    }
    return c.json(
      { purged, failures, next_cursor: uncertain ? null : page.next_cursor },
      200,
    );
  });
  return router;
}
