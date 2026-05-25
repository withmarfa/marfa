import type { MiddlewareHandler } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { getClientIp } from "./client-ip.js";
import type { CidrRange } from "./client-ip.js";
import type { Storage } from "../storage/interface.js";

export interface RateLimitConfig {
  /** Default requests per window. */
  defaultLimit: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Stricter limits by path prefix */
  pathLimits: Record<string, number>;
  /** Trusted reverse-proxy CIDRs for safe x-forwarded-for handling. */
  trustedProxyCidrs: CidrRange[];
  /**
   * Required storage handle. T-026 promoted this to required (was
   * optional pre-T-026) because the rate-limit counter itself now
   * lives in the shared store (`storage.rateLimits`). The handle also
   * carries the per-tenant rate-cap lookup (T-052 follow-on).
   */
  storage: Storage;
  /**
   * Per-tenant default ceiling, read from
   * `MARFA_DEFAULT_QUOTA_RATE_PER_MINUTE`. Falls back to "no
   * tenant-level cap" when undefined. Per-tenant overrides via the
   * tenant_quotas row take precedence.
   */
  tenantDefaultRatePerMinute?: number | null;
}

/**
 * Sliding-window rate limiter backed by `storage.rateLimits` (T-026).
 *
 * The counter table sits in the same database every other tenant-scoped
 * table lives in. Two server instances pointed at the same DB share
 * counters cluster-wide; SQLite is single-process by file lock so the
 * same code path stays correct on single-tenant self-hosts.
 *
 * Hot path: one upsert round-trip per gated request. The per-tenant
 * ceiling LOOKUP (tenant_quotas.rate_per_minute_limit) stays cached
 * in-process for 60s — that's a CAP read, not a counter, and the cache
 * is purely a perf optimisation under correct multi-instance semantics
 * (cache miss → DB read; staleness is bounded by the TTL).
 *
 * Configuration is required — there is no fallback that reads
 * `process.env`. `app.ts` constructs the config from `AppConfig`.
 *
 * **Correctness-first, not perf-first.** The per-request PG round-trip
 * is acceptable at target scale; a write-through per-instance cache
 * (instance-local short-circuit + the DB upsert as the authoritative
 * floor — the T-101 `last_used_at` debounce shape) is a future
 * optimisation if perf measurement demands it. Counter accuracy +
 * cluster-shared correctness come first.
 */
interface TenantLimitCacheEntry {
  /** `null` means "no per-tenant cap" (env default also unset). */
  limit: number | null;
  expiresAt: number;
}

const TENANT_LIMIT_CACHE_TTL_MS = 60_000;

const RATE_FAMILY = "rate";

export function rateLimitMiddleware(
  config: RateLimitConfig,
): MiddlewareHandler<AppEnv> {
  const tenantLimits = new Map<string, TenantLimitCacheEntry>();

  // Periodic cleanup of the in-process tenant-limit cache. The shared
  // `rate_limit_windows` rows have their own retention sweep
  // (`RateLimitWindowCleaner` in storage/retention.ts).
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tenantLimits) {
      if (entry.expiresAt <= now) {
        tenantLimits.delete(key);
      }
    }
  }, config.windowMs * 2);
  cleanupInterval.unref();

  // Expose cleanup for graceful shutdown
  (
    cleanupInterval as unknown as { _rateLimitCleanup: true }
  )._rateLimitCleanup = true;

  /**
   * Fetch the per-tenant rate cap (with cache). Returns `null` for
   * tenants with no override and no env default. T-052.
   */
  async function tenantRateLimit(
    tenantId: string,
    now: number,
  ): Promise<number | null> {
    const cached = tenantLimits.get(tenantId);
    if (cached && cached.expiresAt > now) {
      return cached.limit;
    }

    let limit: number | null = null;
    const quota = await config.storage.tenantQuotas.get(tenantId);
    if (quota?.rate_per_minute_limit != null) {
      limit = quota.rate_per_minute_limit;
    }
    // Fall back to env default if no per-tenant override.
    if (limit === null && config.tenantDefaultRatePerMinute != null) {
      limit = config.tenantDefaultRatePerMinute;
    }

    tenantLimits.set(tenantId, {
      limit,
      expiresAt: now + TENANT_LIMIT_CACHE_TTL_MS,
    });
    return limit;
  }

  return async (c, next) => {
    const apiKey = c.get("apiKey");
    const identifier =
      apiKey?.id ?? getClientIp(c, config.trustedProxyCidrs) ?? "anon";
    const path = c.req.path;

    // Determine limit for this path
    let limit = config.defaultLimit;
    for (const [prefix, pathLimit] of Object.entries(config.pathLimits)) {
      if (path.startsWith(prefix)) {
        limit = pathLimit;
        break;
      }
    }

    // More generous for read-heavy endpoints
    if (c.req.method === "GET" && limit === config.defaultLimit) {
      limit = config.defaultLimit * 2;
    }

    const pathPrefix = path.split("/").slice(0, 2).join("/");
    const credentialWindowKey = `${identifier}:${pathPrefix}`;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const credentialResult = await config.storage.rateLimits.incrementWindow(
      RATE_FAMILY,
      credentialWindowKey,
      config.windowMs,
      nowIso,
    );

    // Set rate limit headers (per-credential window — the most
    // immediate cap most callers will hit).
    c.header("X-RateLimit-Limit", String(limit));
    c.header(
      "X-RateLimit-Remaining",
      String(Math.max(0, limit - credentialResult.count)),
    );
    c.header(
      "X-RateLimit-Reset",
      String(Math.ceil(new Date(credentialResult.expires_at).getTime() / 1000)),
    );

    if (credentialResult.count > limit) {
      const retryAfter = Math.ceil(
        (new Date(credentialResult.expires_at).getTime() - now) / 1000,
      );
      c.header("Retry-After", String(retryAfter));
      throw new MarfaError(
        ErrorCode.RATE_LIMITED,
        `Rate limit exceeded. Try again in ${String(retryAfter)} seconds`,
      );
    }

    // T-052 follow-on: per-tenant ceiling on top of the per-credential
    // window. A noisy single credential is bounded by the cap above;
    // a tenant's collective fleet is bounded here. Skipped for
    // tenant-less keys (single-tenant self-hosts, platform admin).
    const tenantId = apiKey?.tenant_id;
    if (tenantId) {
      const tenantLimitValue = await tenantRateLimit(tenantId, now);
      if (tenantLimitValue !== null) {
        const tenantWindowKey = `tenant:${tenantId}`;
        const tenantResult = await config.storage.rateLimits.incrementWindow(
          RATE_FAMILY,
          tenantWindowKey,
          config.windowMs,
          nowIso,
        );
        if (tenantResult.count > tenantLimitValue) {
          const retryAfter = Math.ceil(
            (new Date(tenantResult.expires_at).getTime() - now) / 1000,
          );
          c.header("Retry-After", String(retryAfter));
          throw new MarfaError(
            ErrorCode.RATE_LIMITED,
            `Tenant rate limit exceeded. Try again in ${String(retryAfter)} seconds`,
          );
        }
      }
    }

    await next();
  };
}
