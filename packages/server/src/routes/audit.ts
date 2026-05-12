import { createRoute, z } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const AuditEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  key_id: z.string().nullable(),
  /**
   * Tenant scope (T-041). Stamped at write time from the calling api key's
   * `tenant_id`. Null for system-initiated audits and bootstrap-admin keys.
   */
  tenant_id: z.string().nullable(),
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.string().nullable(),
  /**
   * Resolved client IP for the action (T-027). Null for system-initiated
   * audits with no Hono context.
   */
  client_ip: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});

const listAuditRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "List audit log entries",
  description:
    "Returns audit-log entries in reverse-chronological order, optionally filtered by `action`, `resource_type`, `resource_id`, or a `since` / `until` time range. Cursor-paginated. Each entry carries the credential that performed the action (`key_id`), the resolved client IP (subject to `TRUSTED_PROXY_CIDRS`), and a structured `details` payload that varies by action.\n\nThe audit log records every state-changing API call plus a few admin-side reads. Item / edge reads, SSE subscribe/unsubscribe, and search queries are NOT logged — those land in request logs instead. Retention is `AUDIT_RETENTION_DAYS` (default 90; per-tenant override via `TenantConfig.audit_retention_days`); older rows are removed by a periodic cleanup job. Tenant-scoped admin keys see their own tenant's rows; tenantless bootstrap-admin keys see every row.\n\nNon-admin credentials return `403 forbidden`. See [Audit log](/concepts/audit).",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      action: z.string().optional(),
      resource_type: z.string().optional(),
      resource_id: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
      cursor: z.string().optional(),
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
  },
});

export function auditRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listAuditRoute, async (c) => {
    requireAdmin(c);
    const { action, resource_type, resource_id, since, until, limit, cursor } =
      c.req.valid("query");

    // T-041: tenant scope. Bootstrap-admin keys (no `tenant_id`) read every
    // row — preserves the self-hosted single-tenant operator view. Tenant-
    // scoped admin keys read only their own tenant. Mirrors the
    // `ItemStore.list` admit-all-when-tenantless pattern.
    const callerTenantId = c.get("apiKey")?.tenant_id ?? null;

    const result = await storage.audit.list({
      action,
      resource_type,
      resource_id,
      since,
      until,
      limit,
      cursor,
      tenant_id: callerTenantId,
    });

    return c.json(result, 200);
  });

  return router;
}
