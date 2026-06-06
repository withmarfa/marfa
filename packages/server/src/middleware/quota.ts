import type { Context } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { QuotaResource } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { AppConfig } from "../config.js";
import type { AppEnv } from "./auth.js";

/**
 * Per-tenant quota enforcement.
 *
 * Checks the current count for `resource` against the effective limit
 * (tenant override OR env default OR Infinity). Throws `QUOTA_EXCEEDED`
 * (HTTP 429) when adding `increment` would push the tenant past their
 * cap. Counts are computed on-demand via `tenantQuotas.count(...)` —
 * no eager-increment / reconcile machinery.
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

  const limit = await effectiveLimit(
    storage,
    tenantId,
    resource,
    c.get("config"),
  );
  if (limit === null) return;

  const current = await storage.tenantQuotas.count(tenantId, resource);
  if (current + increment > limit) {
    throw new MarfaError(
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
  config: AppConfig,
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
  // Instance default — the env vars (`MARFA_DEFAULT_QUOTA_*`) are parsed
  // once in config.ts; consume those values rather than re-reading
  // `process.env` here, so a single config source stays authoritative.
  return configDefault(resource, config);
}

function configDefault(
  resource: QuotaResource,
  config: AppConfig,
): number | null {
  switch (resource) {
    case "items":
      return config.defaultQuotaItems ?? null;
    case "webhooks":
      return config.defaultQuotaWebhooks ?? null;
    case "blobs":
      return config.defaultQuotaBlobs ?? null;
    case "storage_bytes":
      return config.defaultQuotaStorageBytes ?? null;
    case "rate_per_minute":
      return config.defaultQuotaRatePerMinute ?? null;
  }
}
