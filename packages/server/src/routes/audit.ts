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

const AuditEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  key_id: z.string().nullable(),
  /**
   * Space scope. Stamped at write time from the calling api key's
   * `space_id`. Null for system-initiated audits and the bootstrap credential.
   */
  space_id: z.string().nullable(),
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
  description:
    "Returns audit-log entries in reverse-chronological order, filtered by action, resource, or time range, with cursor pagination. Records only state-changing calls and a few admin reads — item/edge reads, SSE, and search are not logged. Requires `space.audit_read`: a space-bound caller sees only its own space's entries, a caller with no space binding sees every entry.",
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
      since: z
        .string()
        .optional()
        .describe("Include entries at or after this timestamp."),
      until: z
        .string()
        .optional()
        .describe("Include entries before this timestamp."),
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
    // Space-bounded, not platform-only: the single storage call below is
    // filtered by the caller's own space, so a space-bound caller reading
    // its own space's trail stays inside its own data.
    requireAuth(c);
    requireSpacePermission(c, "space.audit_read");
    const { action, resource_type, resource_id, since, until, limit, cursor } =
      c.req.valid("query");

    // A credential with no `space_id` reads every row — preserves the
    // instance-wide operator view. A space-bound credential
    // reads only its own space. Mirrors the `ItemStore.list`
    // admit-all-when-space-less pattern.
    const callerSpaceId = c.get("apiKey")?.space_id ?? null;

    const result = await storage.audit.list({
      action,
      resource_type,
      resource_id,
      since,
      until,
      limit,
      cursor,
      space_id: callerSpaceId,
    });

    return c.json(result, 200);
  });

  return router;
}
