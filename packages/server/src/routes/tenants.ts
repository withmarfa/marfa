import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MymeError, TYPE_REGISTRY } from "@mymehq/shared";
import type { TenantConfig } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

const RetentionOverrideSchema = z.object({
  feed_days: z.number().int().positive(),
});

const TenantConfigSchema = z.object({
  retention: z.record(z.string(), RetentionOverrideSchema).optional(),
});

const getConfigRoute = createRoute({
  method: "get",
  path: "/current/config",
  tags: ["Tenants"],
  summary: "Get the current tenant's configuration",
  description:
    "Admin only. Returns tenant-scoped config (per-type feed retention overrides). An empty object is returned when nothing is configured.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": { schema: TenantConfigSchema },
      },
      description: "Tenant config",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
  },
});

const putConfigRoute = createRoute({
  method: "put",
  path: "/current/config",
  tags: ["Tenants"],
  summary: "Replace the current tenant's configuration",
  description:
    "Admin only. Overwrites the tenant's config with the supplied object. Validates that retention type IDs resolve in the registry.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: TenantConfigSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: TenantConfigSchema },
      },
      description: "Tenant config updated",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
  },
});

export function tenantRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getConfigRoute, async (c) => {
    const key = requireAdmin(c);
    if (!key.tenant_id || !storage.tenants) {
      return c.json({}, 200);
    }
    const config = await storage.tenants.getConfig(key.tenant_id);
    return c.json(config ?? {}, 200);
  });

  router.openapi(putConfigRoute, async (c) => {
    const key = requireAdmin(c);
    const body = c.req.valid("json") as TenantConfig;

    if (body.retention) {
      for (const typeId of Object.keys(body.retention)) {
        if (!TYPE_REGISTRY.has(typeId)) {
          throw new MymeError(
            ErrorCode.VALIDATION_ERROR,
            `Unknown type "${typeId}" in retention config`,
            { typeId },
          );
        }
      }
    }

    if (!key.tenant_id || !storage.tenants) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Tenant config requires a tenant-scoped credential",
      );
    }

    await storage.tenants.updateConfig(key.tenant_id, body);
    void storage.audit.log({
      key_id: key.id,
      action: "tenant.config.update",
      resource_type: "tenant",
      resource_id: key.tenant_id,
    });

    return c.json(body, 200);
  });

  return router;
}
