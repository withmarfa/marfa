import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  performUninstall,
  UninstallError,
} from "../connections/uninstall-pipeline.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Connection management routes (T-046 / PR A).
//
// Today this file owns one operation: orchestrated uninstall of an
// `external-service-connector` connection. The CLI (and other admin
// surfaces) gain a single endpoint that revokes runtime credentials,
// drops upstream OAuth tokens, revokes leased tokens, disables inbound
// webhooks, transitions the system.connection to revoked, and emits a
// system.activity row — all in one place. See
// `connections/uninstall-pipeline.ts` for the step-by-step rationale.
//
// Auth model: `requireAdmin`. Tenant admins can uninstall their own
// tenant's connections (the storage lookup is tenant-scoped via
// `apiKey.tenant_id`); platform admins on single-tenant self-hosted
// deployments operate without a tenant scope and reach every
// connection. Non-admin credentials are rejected with 403.
// ---------------------------------------------------------------------------

const ConnectionIdParam = z.object({ id: z.string() });

const UninstallResultSchema = z.object({
  connection_id: z.string(),
  revoked_credential_ids: z.array(z.string()),
  oauth_tokens_deleted: z.boolean(),
  leased_tokens_revoked: z.number().int().nonnegative(),
  inbound_webhooks_disabled: z.number().int().nonnegative(),
  activity_id: z.string(),
});

const uninstallRoute = createRoute({
  method: "post",
  path: "/{id}/uninstall",
  tags: ["Connections"],
  summary: "Orchestrated uninstall of an external-service-connector connection",
  description:
    "Revokes the connection's runtime credentials, deletes any upstream OAuth tokens, revokes active leased tokens, disables inbound webhook subscriptions, transitions the system.connection to state `revoked`, and emits a system.activity row. Audit-logged. Idempotent at the artefact level (revoking an already-revoked artefact is a no-op), but rejects with 400 when the connection itself is already revoked.",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: UninstallResultSchema } },
      description:
        "Connection uninstalled. Body details the artefacts cleaned up.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Connection is not an external-service-connector, or already revoked.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized.",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not an admin.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection not found in this tenant scope.",
    },
  },
});

export function connectionRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(uninstallRoute, async (c) => {
    const apiKey = requireAdmin(c);
    const { id: connectionId } = c.req.valid("param");
    const tenantId = apiKey.tenant_id ?? undefined;
    const clientIp = c.var.clientIp;

    try {
      const result = await performUninstall(storage, {
        apiKeyId: apiKey.id,
        tenantId,
        connectionId,
        clientIp,
      });
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof UninstallError) {
        if (err.code === "connection_not_found") {
          throw new MymeError(ErrorCode.NOT_FOUND, err.message);
        }
        throw new MymeError(ErrorCode.VALIDATION_ERROR, err.message, {
          uninstall_error_code: err.code,
        });
      }
      throw err;
    }
  });

  return r;
}
