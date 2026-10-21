import { createRoute, z } from "@hono/zod-openapi";
import { isValidTypeIdentifier, resolveEnforcement } from "@withmarfa/shared";
import { directAuthorityOnly } from "../middleware/auth.js";
import { snapshotReadRoute } from "../middleware/read-snapshot.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageCursor,
  pageLimit,
} from "../page-limits.js";
import type { Storage } from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { pageOf } from "./_schemas.js";
import { setNoStore } from "./no-store.js";

const ItemSummarySchema = z
  .object({
    id: z.string().describe("Unique identifier for the item."),
    name: z
      .string()
      .describe(
        "The item's plain-text name, derived from its type's display hints and fallback fields.",
      ),
    source: z.string().describe("The source that added the item."),
    created_at: z.string().describe("When the item was created, in UTC."),
  })
  .describe("An item's name, source and creation time, without its content.")
  .openapi("ItemSummary");

const listRoute = createRoute({
  method: "get",
  path: "/summaries",
  operationId: "listItemSummaries",
  tags: ["Items"],
  summary: "List item summaries",
  description:
    "Returns item names, sources and creation times, newest first. Only the owner or a local command can use this operation. Trashed and system items are excluded.",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  request: {
    query: z.object({
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
          "Only return names containing this text, ignoring case and surrounding whitespace.",
        ),
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      description: "Returns a page of item summaries.",
      content: {
        "application/json": {
          schema: pageOf(ItemSummarySchema, "ItemSummaryPage", {
            page: "A page of item names, sources and creation times.",
            data: "The item summaries on this page.",
          }),
          example: {
            data: [
              {
                id: "01900000-0000-7000-8000-000000000001",
                name: "Shopping list",
                source: "notes",
                created_at: "2026-01-01T12:00:00.000Z",
              },
            ],
            next_cursor: null,
          },
        },
      },
    },
    400: {
      description: "`validation_error`: a filter or cursor is invalid.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
    },
    403: {
      description:
        "`forbidden`: the request does not carry direct owner or local authority.",
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
    },
  },
});

export async function summaryFilters(storage: Storage) {
  const config = await readInstanceConfig(storage.settings);
  return { source_filter: resolveEnforcement(config, undefined).source_filter };
}

export function itemSummaryRoutes(storage: Storage) {
  const router = createOpenAPIRouter();
  router.openapi(snapshotReadRoute(storage, listRoute), async (c) => {
    setNoStore(c);
    const query = c.req.valid("query");
    return c.json(
      await storage.items.listSummaries({
        ...query,
        ...(await summaryFilters(storage)),
      }),
      200,
    );
  });
  return router;
}
