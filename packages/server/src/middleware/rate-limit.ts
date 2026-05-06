import type { MiddlewareHandler } from "hono";
import { MymeError, ErrorCode } from "@mymehq/shared";
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
   * T-052 follow-on (Wave B Part 2): optional storage handle so the
   * rate limiter can read each tenant's `rate_per_minute_limit`
   * override on top of the per-credential window. When `undefined`,
   * only the per-credential / per-IP gate runs (existing behaviour).
   *
   * The per-tenant ceiling is the second of two windows: a request
   * is rejected if EITHER the per-credential window OR the per-tenant
   * window is full. Per-credential keeps a single noisy key from
   * spamming; per-tenant keeps a tenant's collective fleet from
   * blowing through the cap.
   */
  storage?: Storage;
  /**
   * Per-tenant default ceiling, read from
   * `MYME_DEFAULT_QUOTA_RATE_PER_MINUTE`. Falls back to "no
   * tenant-level cap" when undefined. Per-tenant overrides via the
   * tenant_quotas row take precedence.
   */
  tenantDefaultRatePerMinute?: number | null;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

/**
 * In-memory sliding window rate limiter.
 * Keys by API key ID (or IP for unauthenticated requests).
 * Path-specific limits for sensitive endpoints.
 *
 * Configuration is required — there is no fallback that reads `process.env`.
 * `app.ts` constructs the config from `AppConfig.rateLimitDefaultLimit` and
 * `rateLimitWindowMs` (the single env-read site lives in `loadConfig`).
 */
/**
 * Per-tenant ceiling cache entry. The cache is in-process with a
 * 60-second TTL: a tenant changing their cap waits at most 60s for
 * the new value to be honoured. Worth the staleness vs. a DB
 * roundtrip per request. Survives across requests for the lifetime
 * of the middleware instance.
 */
interface TenantLimitCacheEntry {
  /** `null` means "no per-tenant cap" (env default also unset). */
  limit: number | null;
  expiresAt: number;
}

const TENANT_LIMIT_CACHE_TTL_MS = 60_000;

export function rateLimitMiddleware(
  config: RateLimitConfig,
): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, WindowEntry>();
  const tenantLimits = new Map<string, TenantLimitCacheEntry>();

  // Periodic cleanup of expired entries — single interval per middleware instance
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (entry.resetAt <= now) {
        windows.delete(key);
      }
    }
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
    if (config.storage) {
      const quota = await config.storage.tenantQuotas.get(tenantId);
      if (quota?.rate_per_minute_limit != null) {
        limit = quota.rate_per_minute_limit;
      }
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

    let entry = windows.get(credentialWindowKey);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + config.windowMs };
      windows.set(credentialWindowKey, entry);
    }

    entry.count++;

    // Set rate limit headers (per-credential window — the most
    // immediate cap most callers will hit).
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      throw new MymeError(
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
      const tenantLimit = await tenantRateLimit(tenantId, now);
      if (tenantLimit !== null) {
        const tenantWindowKey = `tenant:${tenantId}`;
        let tenantEntry = windows.get(tenantWindowKey);
        if (!tenantEntry || tenantEntry.resetAt <= now) {
          tenantEntry = { count: 0, resetAt: now + config.windowMs };
          windows.set(tenantWindowKey, tenantEntry);
        }
        tenantEntry.count++;
        if (tenantEntry.count > tenantLimit) {
          const retryAfter = Math.ceil((tenantEntry.resetAt - now) / 1000);
          c.header("Retry-After", String(retryAfter));
          throw new MymeError(
            ErrorCode.RATE_LIMITED,
            `Tenant rate limit exceeded. Try again in ${String(retryAfter)} seconds`,
          );
        }
      }
    }

    await next();
  };
}
