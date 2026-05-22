import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MymeError } from "@mymehq/shared";
import type { TenantConfig } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, requireTenantAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

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
  enforcement: EnforcementSchema,
  // T-050 — tenant-scoped retention overrides for the cleanup
  // jobs. Each falls back to the instance env default when unset.
  // `0` disables the job for that tenant (matches env-default
  // semantics for `TRASH_RETENTION_DAYS=0`); negatives are rejected.
  audit_retention_days: z.number().int().min(0).optional(),
  event_log_retention_hours: z.number().int().min(0).optional(),
  trash_retention_days: z.number().int().min(0).optional(),
});

const getConfigRoute = createRoute({
  method: "get",
  path: "/current/config",
  tags: ["Tenants"],
  summary: "Get the current tenant's configuration",
  description:
    "Returns the tenant-level configuration. Carries the three optional schema-enforcement levers under `enforcement` (`strict_mode`, `source_allowlist`, `source_filter` — see [Schema enforcement](/concepts/schema-enforcement)) plus the per-tenant cleanup-job overrides (`audit_retention_days`, `event_log_retention_hours`, `trash_retention_days`) that override the instance env defaults per-tenant. Returns an empty object when nothing is configured. Admin or tenant_admin.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": { schema: TenantConfigSchema },
      },
      description: "Tenant config",
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
    "Overwrites the tenant's config with the supplied object — full replacement, not merge. The accepted shape carries the optional `enforcement` block (`strict_mode`, `source_allowlist`, `source_filter`) plus the per-tenant cleanup-job overrides (`audit_retention_days`, `event_log_retention_hours`, `trash_retention_days`). Cleanup-job override values must be non-negative — `0` disables the corresponding job for this tenant.\n\nAdmin or tenant_admin. See [Schema enforcement](/concepts/schema-enforcement).",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description: "Validation error",
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
  summary: "Get tenant quotas",
  description:
    "Returns the per-tenant quota ceilings for a specific tenant — items, webhooks, blobs, storage bytes, and per-minute rate limit. `null` on a field means the env default applies; an entirely-null payload means no per-tenant override is configured. Platform-admin only — workspace admins use `GET /tenants/me/quotas` to read their own ceilings without knowing their tenant id.",
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
      description: "Forbidden",
    },
  },
});

// T-052 follow-on (Wave B Part 2): tenant_admin's read-own surface.
// `GET /tenants/me/quotas` resolves the calling key's tenant_id from
// `c.var.apiKey` so tenant_admins don't need to know — or be told
// — their own tenant_id to read their ceilings. Cleaner than asking
// them to invoke the platform-admin route at `/{tenant_id}/quotas`.
const getOwnQuotasRoute = createRoute({
  method: "get",
  path: "/me/quotas",
  tags: ["Tenants"],
  summary: "Get current tenant quotas",
  description:
    "Returns the calling tenant's quota ceilings, resolved from the calling credential's tenant so the caller doesn't need to know its own tenant id. Returns a row of nulls when no per-tenant override is configured (env defaults apply). Platform-admin keys with no tenant id receive `400` — use `GET /tenants/{id}/quotas` with the explicit id instead. Admin or tenant_admin.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: QuotaSchema } },
      description: "Quota row for the calling tenant.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Caller has no tenant_id (platform admin).",
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
      description: "Forbidden",
    },
  },
});

const putQuotasRoute = createRoute({
  method: "put",
  path: "/{id}/quotas",
  tags: ["Tenants"],
  summary: "Update tenant quotas",
  description:
    "Sets the per-tenant quota ceilings for a specific tenant. Each field is independent — supplied non-null values override the env default; supplied `null` resets to the env default for that field. Platform-admin only.",
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

  // T-052: per-tenant quota administration.
  //
  // **Route order matters.** The `/me/quotas` route is registered BEFORE
  // `/{id}/quotas` so a request to `GET /tenants/me/quotas` matches the
  // tenant-admin handler instead of the platform-admin handler with
  // `id="me"`. Hono dispatches in registration order; flipping these
  // would surface as a 403 for tenant_admin (caught in the test
  // suite — see `auth.tenant-admin-completeness.test.ts`).
  router.openapi(getOwnQuotasRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const tenantId = key.tenant_id;
    if (!tenantId) {
      // Platform admin keys (no tenant_id) hit this — they should use
      // the explicit `/tenants/{id}/quotas` route instead.
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Caller has no tenant_id; use GET /tenants/{id}/quotas with an explicit tenant id.",
      );
    }
    const quota = await storage.tenantQuotas.get(tenantId);
    return c.json(
      {
        tenant_id: tenantId,
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

  // Platform-admin only — setting another tenant's caps is cross-tenant authority.
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
