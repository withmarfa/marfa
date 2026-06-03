/**
 * `/admin/*` operator surface. Every route in this file is platform-
 * admin only (`requireAdmin` enforces). The CLI's `my platform` command
 * tree is the canonical consumer; the routes are also reachable directly
 * via the SDK's `client.admin` namespace.
 *
 * Routes:
 *
 *   - GET    /admin/tenants                       — list all tenants
 *   - GET    /admin/tenants/:id                   — full row + quotas + recent activity
 *   - POST   /admin/tenants/:id/suspend           — flip status to 'suspended'
 *   - POST   /admin/tenants/:id/unsuspend         — flip status to 'active'
 *   - GET    /admin/tenants/:id/metrics           — usage snapshot
 *   - GET    /admin/tenants/:id/keys              — a tenant's API keys
 *   - POST   /admin/account-deletion/purge-now    — force a one-shot pending-delete sweep (T-124)
 *
 * Quotas READ/WRITE for a specific tenant reuses the existing
 * `/tenants/:id/quotas` GET + PUT (already platform-admin-gated). No
 * `/admin/tenants/:id/quotas` shim is added — the CLI hits the existing
 * route directly.
 *
 * Suspend / unsuspend each emit a `tenant.suspend` / `tenant.unsuspend`
 * audit row with the actor key id, target tenant id, and timestamp.
 * `account-deletion/purge-now` emits an `admin.account_deletion.purge_now`
 * audit row with `tenant_id: null` (instance-wide sweep). Suspended
 * tenants reject writes at the auth middleware layer
 * (`middleware/tenant-suspension.ts`); platform admins bypass.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { evictTenantStatus } from "../middleware/tenant-suspension.js";
import { PendingDeletePurger } from "../storage/retention.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TenantSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  created_at: z.string(),
  status: z.enum(["active", "suspended"]),
});

const QuotaSchema = z.object({
  tenant_id: z.string(),
  items_limit: z.number().int().nullable(),
  webhooks_limit: z.number().int().nullable(),
  blobs_limit: z.number().int().nullable(),
  storage_bytes_limit: z.number().int().nullable(),
  rate_per_minute_limit: z.number().int().nullable(),
  updated_at: z.string().nullable(),
});

const ActivityEntrySchema = z.object({
  id: z.string(),
  severity: z.string(),
  summary: z.string(),
  created_at: z.string(),
});

const TenantShowSchema = z.object({
  tenant: TenantSchema,
  quotas: QuotaSchema.nullable(),
  recent_activity: z.array(ActivityEntrySchema),
});

const TenantMetricsSchema = z.object({
  tenant_id: z.string(),
  items: z.object({
    total: z.number(),
    active: z.number(),
    archived: z.number(),
    trashed: z.number(),
  }),
  blobs: z.object({
    count: z.number(),
    total_size: z.number(),
  }),
  recent_activity: z.array(ActivityEntrySchema),
  generated_at: z.string(),
});

const ApiKeySummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.string(),
  is_platform: z.boolean(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listTenantsRoute = createRoute({
  operationId: "adminListTenants",
  method: "get",
  path: "/tenants",
  tags: ["Admin"],
  summary: "List tenants",
  description:
    "Lists every tenant in the instance with current operator status. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(TenantSchema) }),
        },
      },
      description: "Tenant list",
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

const showTenantRoute = createRoute({
  operationId: "adminGetTenant",
  method: "get",
  path: "/tenants/{id}",
  tags: ["Admin"],
  summary: "Show a tenant",
  description:
    "Returns the tenant row, its current quota overrides, and a slice of recent activity. Quota overrides are null when none are configured. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Tenant id.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: TenantShowSchema } },
      description: "Tenant detail",
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
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Tenant not found",
    },
  },
});

const suspendTenantRoute = createRoute({
  operationId: "adminSuspendTenant",
  method: "post",
  path: "/tenants/{id}/suspend",
  tags: ["Admin"],
  summary: "Suspend a tenant",
  description:
    "Suspends the tenant, after which its credentials are rejected on writes while reads still pass through. Idempotent; re-suspending is a no-op.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Tenant id to suspend.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: TenantSchema } },
      description: "Updated tenant row",
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
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Tenant not found",
    },
  },
});

const unsuspendTenantRoute = createRoute({
  operationId: "adminUnsuspendTenant",
  method: "post",
  path: "/tenants/{id}/unsuspend",
  tags: ["Admin"],
  summary: "Unsuspend a tenant",
  description:
    "Reactivates a suspended tenant, restoring write access. Idempotent.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Tenant id to unsuspend.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: TenantSchema } },
      description: "Updated tenant row",
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
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Tenant not found",
    },
  },
});

const tenantMetricsRoute = createRoute({
  operationId: "adminGetTenantMetrics",
  method: "get",
  path: "/tenants/{id}/metrics",
  tags: ["Admin"],
  summary: "Get tenant metrics",
  description:
    "Returns a per-tenant usage snapshot covering item, blob, and storage counts plus recent activity. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Tenant id.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: TenantMetricsSchema } },
      description: "Metrics snapshot",
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
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Tenant not found",
    },
  },
});

const listTenantKeysRoute = createRoute({
  operationId: "adminListTenantKeys",
  method: "get",
  path: "/tenants/{id}/keys",
  tags: ["Admin"],
  summary: "List a tenant's API keys",
  description:
    "Lists active (non-revoked) API keys for a tenant, for emergency revocation paired with key deletion. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Tenant id.") }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(ApiKeySummarySchema) }),
        },
      },
      description: "Key list",
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

const PurgeNowResponseSchema = z.object({
  purged_count: z.number().int().nonnegative(),
  run_at: z.string(),
});

const accountDeletionPurgeNowRoute = createRoute({
  operationId: "adminPurgePendingDeletions",
  method: "post",
  path: "/account-deletion/purge-now",
  tags: ["Admin"],
  summary: "Force a one-shot run of the pending-delete purger",
  description:
    "Runs the pending-deletion sweep immediately instead of waiting for the scheduled job, returning the count purged. Only sweeps accounts already past their grace window; it does not bypass that window.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: PurgeNowResponseSchema } },
      description: "Purge sweep completed; returns count + timestamp",
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
// Handlers
// ---------------------------------------------------------------------------

const RECENT_ACTIVITY_LIMIT = 10;

interface ActivitySummary {
  id: string;
  severity: string;
  summary: string;
  created_at: string;
}

async function loadRecentActivity(
  storage: Storage,
  tenantId: string,
  limit: number = RECENT_ACTIVITY_LIMIT,
): Promise<ActivitySummary[]> {
  const page = await storage.items.list({
    tenantId,
    type: "system.activity",
    sort: "created_at",
    direction: "desc",
    limit,
  });
  return page.data.map((item) => {
    const props = item.properties;
    return {
      id: item.id,
      severity: typeof props.severity === "string" ? props.severity : "info",
      summary: typeof props.summary === "string" ? props.summary : "",
      created_at: item.created_at,
    };
  });
}

function apiKeySummary(key: ApiKey): z.infer<typeof ApiKeySummarySchema> {
  return {
    id: key.id,
    label: key.label,
    source: key.source,
    role: key.role,
    is_platform: key.is_platform,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
  };
}

/** Options threaded into `adminRoutes()` for routes that need
 *  config-derived knobs. `graceDays` is the same value the long-lived
 *  `PendingDeletePurger` singleton uses; the purge-now route constructs
 *  an ad-hoc purger with this value to keep the same eligibility math. */
export interface AdminRoutesOptions {
  graceDays: number;
}

export function adminRoutes(storage: Storage, opts: AdminRoutesOptions) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listTenantsRoute, async (c) => {
    requireAdmin(c);
    if (!storage.tenants) {
      return c.json({ data: [] }, 200);
    }
    const data = await storage.tenants.list();
    return c.json({ data }, 200);
  });

  router.openapi(showTenantRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.tenants) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Tenant store not available");
    }
    const tenant = await storage.tenants.get(id);
    if (!tenant) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Tenant ${id} not found`);
    }

    const quota = await storage.tenantQuotas.get(id);
    const quotas = quota
      ? {
          tenant_id: id,
          items_limit: quota.items_limit ?? null,
          webhooks_limit: quota.webhooks_limit ?? null,
          blobs_limit: quota.blobs_limit ?? null,
          storage_bytes_limit: quota.storage_bytes_limit ?? null,
          rate_per_minute_limit: quota.rate_per_minute_limit ?? null,
          updated_at: quota.updated_at,
        }
      : null;

    const recent_activity = await loadRecentActivity(storage, id);
    return c.json({ tenant, quotas, recent_activity }, 200);
  });

  router.openapi(suspendTenantRoute, async (c) => {
    const actor = requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.tenants) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Tenant store not available");
    }
    const updated = await storage.tenants.suspend(id);
    if (!updated) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Tenant ${id} not found`);
    }
    // Drop the per-instance status cache so the next gated write reads
    // the fresh `suspended` value instead of waiting out the 5s TTL.
    evictTenantStatus(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      // Stamp the target tenant so the suspended tenant's own audit
      // feed surfaces the event. (The actor is a platform admin and
      // tenant-less; using their tenant_id here would hide the row from
      // the target tenant's `GET /audit` scope.)
      tenant_id: id,
      key_id: actor.id,
      action: "tenant.suspend",
      resource_type: "tenant",
      resource_id: id,
    });
    return c.json(updated, 200);
  });

  router.openapi(unsuspendTenantRoute, async (c) => {
    const actor = requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.tenants) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Tenant store not available");
    }
    const updated = await storage.tenants.unsuspend(id);
    if (!updated) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Tenant ${id} not found`);
    }
    evictTenantStatus(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      // Stamp the target tenant so the suspended tenant's own audit
      // feed surfaces the event. (The actor is a platform admin and
      // tenant-less; using their tenant_id here would hide the row from
      // the target tenant's `GET /audit` scope.)
      tenant_id: id,
      key_id: actor.id,
      action: "tenant.unsuspend",
      resource_type: "tenant",
      resource_id: id,
    });
    return c.json(updated, 200);
  });

  router.openapi(tenantMetricsRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.tenants) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Tenant store not available");
    }
    const tenant = await storage.tenants.get(id);
    if (!tenant) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Tenant ${id} not found`);
    }

    // Per-tenant stats. `items.stats(tenantId)` returns a state→count
    // map for the named tenant. `tenantQuotas.count(id, resource)` is
    // tenant-scoped and lives next to the quota-enforcement code; reuse
    // it for blobs + storage_bytes rather than re-implementing the SQL.
    //
    // Custom type count is intentionally omitted from the per-tenant
    // metrics — `TypeStore.countCustom` is instance-wide and there's no
    // tenant-scoped equivalent yet. The instance-wide value lives on
    // `GET /metrics` for platform admins; surfacing it here would
    // imply a per-tenant breakdown that doesn't exist.
    const [itemStats, blobsCount, storageBytes, recent] = await Promise.all([
      storage.items.stats(id),
      storage.tenantQuotas.count(id, "blobs"),
      storage.tenantQuotas.count(id, "storage_bytes"),
      loadRecentActivity(storage, id),
    ]);
    const total = Object.values(itemStats).reduce((a, b) => a + b, 0);
    const active = itemStats.active ?? 0;
    const archived = itemStats.archived ?? 0;
    const trashed = itemStats.trashed ?? 0;

    return c.json(
      {
        tenant_id: id,
        items: { total, active, archived, trashed },
        blobs: { count: blobsCount, total_size: storageBytes },
        recent_activity: recent,
        generated_at: new Date().toISOString(),
      },
      200,
    );
  });

  router.openapi(listTenantKeysRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.tenants) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Tenant store not available");
    }
    const tenant = await storage.tenants.get(id);
    if (!tenant) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Tenant ${id} not found`);
    }
    const keys = await storage.keys.listForTenant(id);
    return c.json({ data: keys.map(apiKeySummary) }, 200);
  });

  router.openapi(accountDeletionPurgeNowRoute, async (c) => {
    const actor = requireAdmin(c);
    // Construct an ad-hoc purger — the long-lived singleton in
    // `index.ts` carries its own timer + coordination lock; this
    // one-shot doesn't need either of those wired in (intervalMs is
    // unused by `runOnce()`). Coordination is still passed through so
    // the per-account inner lock prevents racing the cascade against
    // the periodic sweeper.
    const purger = new PendingDeletePurger(
      storage,
      opts.graceDays,
      0,
      undefined,
      storage.coordination,
    );
    const runAt = new Date().toISOString();
    const purgedCount = await purger.runOnce();
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      // Instance-wide sweep — no target tenant. NULL tenant_id keeps
      // the row out of any specific tenant's `GET /audit` scope; only
      // a platform-admin reading the raw audit_log surfaces it.
      tenant_id: null,
      key_id: actor.id,
      action: "admin.account_deletion.purge_now",
      resource_type: "system",
      resource_id: "account-deletion-purger",
      details: { purged_count: purgedCount, run_at: runAt },
    });
    return c.json({ purged_count: purgedCount, run_at: runAt }, 200);
  });

  return router;
}
