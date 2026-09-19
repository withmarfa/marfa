import { createRoute, z } from "@hono/zod-openapi";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../page-limits.js";
import type { AppEnv } from "../middleware/auth.js";
import { requireSpacePermission, requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  refuseUnknownQueryParams,
  UNKNOWN_PARAM_NOTE,
} from "./_unknown-query-keys.js";

const AuditEntrySchema = z.object({
  id: z.string(),
  created_at: z.string(),
  key_id: z.string().nullable(),
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.string().nullable(),
  /**
   * Resolved client IP for the action. Null for system-initiated audits
   * with no Hono context.
   */
  client_ip: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});

const listAuditRoute = createRoute({
  operationId: "listAuditLog",
  method: "get",
  path: "/",
  tags: ["Audit"],
  summary: "List audit log entries",
  description: `Returns audit-log entries in reverse-chronological order, filtered by action, resource, or time range, with cursor pagination. Records only state-changing calls and a few admin reads — item/edge reads, SSE, and search are not logged. Requires \`space.audit_read\`, and answers a caller's own space and nothing else. A credential with no space holds no space permission, so it is refused rather than shown the whole trail. ${UNKNOWN_PARAM_NOTE}`,
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      action: z.string().optional().describe("Filter to a single action."),
      resource_type: z
        .string()
        .optional()
        .describe("Filter to a single resource type."),
      resource_id: z
        .string()
        .optional()
        .describe("Filter to a single resource id."),
      created_after: z
        .string()
        .optional()
        .describe("Include entries written strictly after this instant."),
      created_before: z
        .string()
        .optional()
        .describe("Include entries written strictly before this instant."),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .optional()
        .default(DEFAULT_PAGE_LIMIT)
        .describe(
          `Maximum entries to return (${String(MIN_PAGE_LIMIT)}–${String(MAX_PAGE_LIMIT)}, default ${String(DEFAULT_PAGE_LIMIT)}).`,
        ),
      cursor: z
        .string()
        .optional()
        .describe("Opaque pagination cursor from a previous response."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(AuditEntrySchema),
            cursor: z.string().nullable(),
            has_more: z.boolean(),
          }),
        },
      },
      description: "Paginated audit log entries",
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
      description: "Caller does not hold `space.audit_read`",
    },
  },
});

export function auditRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listAuditRoute, async (c) => {
    requireAuth(c);
    requireSpacePermission(c, "space.audit_read");
    refuseUnknownQueryParams(c.req.raw.url, listAuditRoute.request.query);
    const {
      action,
      resource_type,
      resource_id,
      created_after,
      created_before,
      limit,
      cursor,
    } = c.req.valid("query");

    const result = await storage.audit.list({
      action,
      resource_type,
      resource_id,
      created_after,
      created_before,
      limit,
      cursor,
    });

    return c.json(result, 200);
  });

  return router;
}
