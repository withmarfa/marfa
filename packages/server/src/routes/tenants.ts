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

const EnforcementSchema = z
  .object({
    strict_mode: z.object({ types: z.array(z.string()) }).optional(),
    source_allowlist: z
      .object({
        types: z.array(z.string()),
        sources: z.array(z.string()),
      })
      .optional(),
    source_filter: z
      .object({
        types: z.array(z.string()),
        sources: z.array(z.string()),
      })
      .optional(),
  })
  .optional();

const TenantConfigSchema = z.object({
  retention: z.record(z.string(), RetentionOverrideSchema).optional(),
  enforcement: EnforcementSchema,
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

// ---------------------------------------------------------------------------
// T-052: Tenant quotas
// ---------------------------------------------------------------------------

const QuotaSchema = z.object({
  tenant_id: z.string(),
  items_limit: z.number().int().nullable(),
  webhooks_limit: z.number().int().nullable(),
  blobs_limit: z.number().int().nullable(),
  storage_bytes_limit: z.number().int().nullable(),
  rate_per_minute_limit: z.number().int().nullable(),
  updated_at: z.string().nullable(),
});

const getQuotasRoute = createRoute({
  method: "get",
  path: "/{id}/quotas",
  tags: ["Tenants"],
  summary: "Read per-tenant quota ceilings (admin only)",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { "application/json": { schema: QuotaSchema } },
      description:
        "Quota row. Null fields mean 'fall back to env defaults'. " +
        "An entirely-null payload means no per-tenant override is set.",
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

const putQuotasRoute = createRoute({
  method: "put",
  path: "/{id}/quotas",
  tags: ["Tenants"],
  summary: "Set per-tenant quota ceilings (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items_limit: z.number().int().nullable().optional(),
            webhooks_limit: z.number().int().nullable().optional(),
            blobs_limit: z.number().int().nullable().optional(),
            storage_bytes_limit: z.number().int().nullable().optional(),
            rate_per_minute_limit: z.number().int().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: QuotaSchema } },
      description: "Quota row updated.",
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
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: key.id,
      action: "tenant.config.update",
      resource_type: "tenant",
      resource_id: key.tenant_id,
    });

    return c.json(body, 200);
  });

  // T-052: per-tenant quota administration. Platform-admin only —
  // setting another tenant's caps is a cross-tenant authority operation.
  // Workspace_admin's read-own surface (`GET /tenants/me/quotas`) is
  // a follow-on; until then the calling admin's own tenant_id can be
  // queried via `GET /admin/tenants/:id/quotas` with their own id.
  router.openapi(getQuotasRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    const quota = await storage.tenantQuotas.get(id);
    return c.json(
      {
        tenant_id: id,
        items_limit: quota?.items_limit ?? null,
        webhooks_limit: quota?.webhooks_limit ?? null,
        blobs_limit: quota?.blobs_limit ?? null,
        storage_bytes_limit: quota?.storage_bytes_limit ?? null,
        rate_per_minute_limit: quota?.rate_per_minute_limit ?? null,
        updated_at: quota?.updated_at ?? null,
      },
      200,
    );
  });

  router.openapi(putQuotasRoute, async (c) => {
    const key = requireAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await storage.tenantQuotas.set(id, body);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: key.id,
      action: "tenant.quotas.update",
      resource_type: "tenant",
      resource_id: id,
      details: body,
    });
    return c.json(
      {
        tenant_id: id,
        items_limit: result.items_limit ?? null,
        webhooks_limit: result.webhooks_limit ?? null,
        blobs_limit: result.blobs_limit ?? null,
        storage_bytes_limit: result.storage_bytes_limit ?? null,
        rate_per_minute_limit: result.rate_per_minute_limit ?? null,
        updated_at: result.updated_at,
      },
      200,
    );
  });

  return router;
}
