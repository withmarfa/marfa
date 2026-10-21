import { createRoute, z } from "@hono/zod-openapi";
import {
  requireDirectAuthority,
  standingRule,
  type AppEnv,
} from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  pageCursor,
  pageLimit,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../page-limits.js";
import type { Storage } from "../storage/interface.js";
import { listFolders } from "../folder-inventory.js";
import { pageOf } from "./_schemas.js";

const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listFolders",
  tags: ["Folders"],
  summary: "List folders",
  description:
    "Returns active folder summaries, newest first, for the owner or a private local command. Revoked folders are excluded. Read reported copies with `GET /folders/{id}/status`.",
  security: [{ bearerAuth: [] }],
  middleware: standingRule("owner or local command", requireDirectAuthority),
  request: {
    query: z.object({
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      description: "Returns one page of active folder summaries.",
      content: {
        "application/json": {
          schema: pageOf(
            z
              .object({
                id: z.string().describe("The folder's item ID."),
                title: z
                  .string()
                  .describe(
                    "The folder's title, with surrounding and repeated whitespace removed; Untitled folder if blank.",
                  ),
                created_at: z
                  .string()
                  .describe("When the folder was created, in UTC."),
              })
              .openapi("FolderSummary", {
                description:
                  "An active folder's identity, without settings or item content.",
              }),
            "FolderSummaryPage",
            {
              page: "One page of active folders.",
              data: "The folder summaries on this page.",
            },
          ),
        },
      },
    },
    400: {
      description:
        "- `validation_error`: a query field, page limit, or cursor is invalid.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
    },
    401: {
      description: "- `unauthorized`: authentication is required.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
    },
    403: {
      description:
        "- `forbidden`: only the owner or a private local command can list folders.",
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
    },
  },
});
export function folderInventoryRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();
  router.openapi(route, async (c) => {
    const { limit, cursor } = c.req.valid("query");
    return c.json(
      await storage.runInTransaction(async () => {
        requireDirectAuthority(c);
        return listFolders(storage, limit, cursor);
      }),
      200,
    );
  });
  return router;
}
