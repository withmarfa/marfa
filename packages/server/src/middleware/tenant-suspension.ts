/**
 * Tenant-suspension write-guard middleware.
 *
 * Sits AFTER `authMiddleware` in the middleware chain. After credential
 * resolution, for every non-GET request, if the credential's tenant is
 * `status: 'suspended'` and the credential is not `is_platform`, the
 * middleware rejects with HTTP 403 `tenant_suspended`. Reads pass
 * through regardless; platform-admin keys bypass so operators can
 * inspect a suspended tenant.
 *
 * The gate sits at middleware (not per-route) so every present AND
 * future mutation route is covered without each route remembering to
 * opt in. The corollary is that admin-side writes that target the
 * suspended tenant (e.g. unsuspending it) are issued by a platform
 * admin key, which the gate bypasses anyway.
 *
 * **Bypass paths:**
 *
 *   - GET / HEAD / OPTIONS — reads + preflight always pass through.
 *   - Anonymous requests (`c.var.apiKey === undefined`) — covers
 *     bootstrap (`POST /keys` when not yet bootstrapped) and the
 *     unauthenticated auth surfaces (`/auth/sign-in`, etc.). These don't
 *     carry a tenant in the credential — there's nothing to gate.
 *   - Tenant-less credentials (`apiKey.tenant_id === undefined`) —
 *     single-tenant self-hosts and the platform-admin bootstrap. No
 *     tenant means no per-tenant status.
 *   - `is_platform: true` credentials — operators MUST be able to write
 *     to a suspended tenant to suspend it further, change quotas, or
 *     unsuspend it.
 *
 * **Runtime-credential keys are NOT exempt.** Connector runtime keys
 * (`is_runtime_credential: true`) carry a `tenant_id` and are
 * non-platform — they hit the gate like any other tenant credential.
 * Suspending a tenant therefore stops their connectors from writing
 * upstream, which is the desired blast-radius.
 *
 * **Caching.** Tenant status is read on the hot path of every write;
 * we cache `(tenant_id) -> status` in-memory with a 5s TTL keyed by
 * tenant_id. Multi-instance deployments tolerate up to 5s of stale
 * status — the worst case is one extra write being allowed through
 * just after a suspend lands, which the next request catches.
 */
import { createMiddleware } from "hono/factory";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { TenantStatus } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { AppEnv } from "./auth.js";

const TTL_MS = 5_000;

interface CacheEntry {
  status: TenantStatus;
  expires_at: number;
}

/**
 * Module-scoped cache so the suspend → write-rejected test (which can
 * pre-populate the entry by issuing a write BEFORE the suspend lands)
 * can drop the stale entry via `_clearTenantStatusCacheForTesting`. In
 * production the cache simply ages out after 5s. Module scope is safe
 * because tenant_id is globally unique and the cache value (current
 * status) is the same across every middleware instance.
 */
const tenantStatusCache = new Map<string, CacheEntry>();

/** Test-only: drop every cached status row. */
export function _clearTenantStatusCacheForTesting(): void {
  tenantStatusCache.clear();
}

/**
 * Drop the cached status for a single tenant. Called by the admin
 * suspend/unsuspend routes immediately after the write, so the next
 * gated request reads the fresh status from storage instead of waiting
 * out the 5s TTL. Multi-instance deployments still tolerate up to 5s
 * of staleness on peer instances (no shared cache), which is the
 * intentional cross-instance fallback.
 */
export function evictTenantStatus(tenantId: string): void {
  tenantStatusCache.delete(tenantId);
}

/**
 * Build the middleware bound to a storage instance. The cache lives at
 * module scope (see above) — the closure here only captures `storage`.
 */
export function tenantSuspensionMiddleware(storage: Storage) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    const apiKey = c.get("apiKey");
    if (!apiKey?.tenant_id) {
      return next();
    }

    if (apiKey.is_platform) {
      return next();
    }

    // Fail open when the tenant store is absent (single-tenant self-hosts).
    const tenants = storage.tenants;
    if (!tenants) {
      return next();
    }

    const tenantId = apiKey.tenant_id;
    const now = Date.now();

    let entry = tenantStatusCache.get(tenantId);
    if (!entry || entry.expires_at <= now) {
      const status = await tenants.getStatus(tenantId);
      // Unknown tenant: treat as `active` — auth has already validated the
      // credential against a real `tenant_id`, so the absence of a row
      // here would be a bug elsewhere. Fail open and let downstream
      // surface the real error.
      entry = {
        status: status ?? "active",
        expires_at: now + TTL_MS,
      };
      tenantStatusCache.set(tenantId, entry);
    }

    if (entry.status === "suspended") {
      throw new MarfaError(
        ErrorCode.TENANT_SUSPENDED,
        "This tenant is suspended; writes are not accepted. Contact your operator.",
      );
    }

    return next();
  });
}
