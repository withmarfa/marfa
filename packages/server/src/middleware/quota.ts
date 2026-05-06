import type { Context } from "hono";
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { QuotaResource } from "@mymehq/shared";
import type { Storage } from "../storage/interface.js";
import type { AppEnv } from "./auth.js";

/**
 * T-052: per-tenant quota enforcement.
 *
 * Checks the current count for `resource` against the effective limit
 * (tenant override OR env default OR Infinity). Throws `QUOTA_EXCEEDED`
 * (HTTP 429) when adding `increment` would push the tenant past their
 * cap. Counts are computed on-demand via `tenantQuotas.count(...)` —
 * no eager-increment / reconcile machinery in this PR; the eager path
 * is filed as a follow-on once load measurements justify the
 * complexity.
 *
 * **No-op when caller has no tenant_id.** Platform-admin keys (single-
 * tenant self-hosts and the bootstrap admin) bypass quota enforcement
 * entirely — there's no "tenant" to constrain. Hosted-mode tenant
 * credentials always carry a `tenant_id` so they pass through the
 * check.
 *
 * **No-op when limit is unset.** A NULL `<resource>_limit` on the
 * tenant_quotas row plus an unset env default means "unlimited"; the
 * check returns immediately.
 */
export async function enforceQuota(
  c: Context<AppEnv>,
  storage: Storage,
  resource: QuotaResource,
  increment = 1,
): Promise<void> {
  const tenantId = c.get("apiKey")?.tenant_id;
  if (!tenantId) return;

  const limit = await effectiveLimit(storage, tenantId, resource);
  if (limit === null) return;

  const current = await storage.tenantQuotas.count(tenantId, resource);
  if (current + increment > limit) {
    throw new MymeError(
      ErrorCode.QUOTA_EXCEEDED,
      `Tenant quota for ${resource} exceeded`,
      { resource, limit, current },
    );
  }
}

/** Returns null when no limit applies (unlimited). */
async function effectiveLimit(
  storage: Storage,
  tenantId: string,
  resource: QuotaResource,
): Promise<number | null> {
  const quota = await storage.tenantQuotas.get(tenantId);
  if (quota) {
    const tenantLimit = (() => {
      switch (resource) {
        case "items":
          return quota.items_limit;
        case "webhooks":
          return quota.webhooks_limit;
        case "blobs":
          return quota.blobs_limit;
        case "storage_bytes":
          return quota.storage_bytes_limit;
        case "rate_per_minute":
          return quota.rate_per_minute_limit;
      }
    })();
    if (tenantLimit !== null && tenantLimit !== undefined) return tenantLimit;
  }
  // Env defaults — read directly from process.env to avoid threading
  // AppConfig through every route. Same parsing semantics as
  // `parseQuotaEnv` in config.ts.
  return envDefault(resource);
}

function envDefault(resource: QuotaResource): number | null {
  const raw = (() => {
    switch (resource) {
      case "items":
        return process.env.MYME_DEFAULT_QUOTA_ITEMS;
      case "webhooks":
        return process.env.MYME_DEFAULT_QUOTA_WEBHOOKS;
      case "blobs":
        return process.env.MYME_DEFAULT_QUOTA_BLOBS;
      case "storage_bytes":
        return process.env.MYME_DEFAULT_QUOTA_STORAGE_BYTES;
      case "rate_per_minute":
        return process.env.MYME_DEFAULT_QUOTA_RATE_PER_MINUTE;
    }
  })();
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}
