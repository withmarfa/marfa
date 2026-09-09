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
   * Required storage handle. The rate-limit counter lives in the shared
   * store (`storage.rateLimits`) and the per-space rate-cap lookup
   * reads `storage.spaceQuotas`.
   */
  storage: Storage;
  /**
   * Per-space default ceiling, read from
   * `MARFA_DEFAULT_QUOTA_RATE_PER_MINUTE`. Falls back to "no
   * space-level cap" when undefined. Per-space overrides via the
   * space_quotas row take precedence.
   */
  spaceDefaultRatePerMinute?: number | null;
  /**
   * Multiplier for the aggregate per-identifier window (see below).
   * The aggregate cap is `defaultLimit * aggregateMultiplier`. Default
   * `4`. Must be `>= 1` — a value below 1 would make the aggregate cap
   * tighter than a single path group's cap and reject normal traffic.
   * Set to `0` to disable the aggregate window entirely (the legacy
   * per-path-only behavior).
   */
  aggregateMultiplier?: number;
}

const DEFAULT_AGGREGATE_MULTIPLIER = 4;

/**
 * Fixed-window rate limiter backed by `storage.rateLimits`: a window's
 * `expires_at` is stamped on its first request and does not roll on
 * increments, so a cap of N admits exactly N requests per window and
 * the whole budget refreshes when the window lapses.
 *
 * The counter table sits in the same database every other space-scoped
 * table lives in. Two server instances pointed at the same DB share
 * counters cluster-wide; SQLite is single-process by file lock so the
 * same code path stays correct on a self-hosted instance.
 *
 * Hot path: one upsert round-trip per gated request. The per-space
 * ceiling lookup (space_quotas.rate_per_minute_limit) stays cached
 * in-process for 60s — that's a cap read, not a counter, and the cache
 * is purely a perf optimization (cache miss → DB read; staleness is
 * bounded by the TTL).
 *
 * Configuration is required — there is no fallback that reads
 * `process.env`. `app.ts` constructs the config from `AppConfig`.
 */
interface SpaceLimitCacheEntry {
  /** `null` means "no per-space cap" (env default also unset). */
  limit: number | null;
  expiresAt: number;
}

const SPACE_LIMIT_CACHE_TTL_MS = 60_000;

const RATE_FAMILY = "rate";

export function rateLimitMiddleware(
  config: RateLimitConfig,
): MiddlewareHandler<AppEnv> {
  const spaceLimits = new Map<string, SpaceLimitCacheEntry>();

  // Aggregate per-identifier cap = defaultLimit * multiplier. The per-path
  // window below is keyed on `(identifier, pathPrefix)`, so an identifier's
  // effective budget multiplies across every path group it touches — and
  // space-less keys (IP/anon callers, the operator key) have no per-space
  // aggregate cap to fall back on. The aggregate window keys on the
  // identifier ALONE (no path split) to bound that total. The multiplier
  // keeps the per-path window the primary cap most callers hit, with the
  // aggregate as a backstop. `0` disables it (legacy per-path-only behavior).
  const aggregateMultiplier =
    config.aggregateMultiplier ?? DEFAULT_AGGREGATE_MULTIPLIER;
  const aggregateLimit =
    aggregateMultiplier > 0 ? config.defaultLimit * aggregateMultiplier : 0;

  // Periodic cleanup of the in-process space-limit cache. The shared
  // `rate_limit_windows` rows have their own retention sweep
  // (`RateLimitWindowCleaner` in storage/retention.ts).
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of spaceLimits) {
      if (entry.expiresAt <= now) {
        spaceLimits.delete(key);
      }
    }
  }, config.windowMs * 2);
  cleanupInterval.unref();

  /**
   * Fetch the per-space rate cap (with cache). Returns `null` for
   * spaces with no override and no env default.
   */
  async function spaceRateLimit(
    spaceId: string,
    now: number,
  ): Promise<number | null> {
    const cached = spaceLimits.get(spaceId);
    if (cached && cached.expiresAt > now) {
      return cached.limit;
    }

    let limit: number | null = null;
    const quota = await config.storage.spaceQuotas.get(spaceId);
    if (quota?.rate_per_minute_limit != null) {
      limit = quota.rate_per_minute_limit;
    }
    // Fall back to env default if no per-space override.
    if (limit === null && config.spaceDefaultRatePerMinute != null) {
      limit = config.spaceDefaultRatePerMinute;
    }

    spaceLimits.set(spaceId, {
      limit,
      expiresAt: now + SPACE_LIMIT_CACHE_TTL_MS,
    });
    return limit;
  }

  return async (c, next) => {
    const apiKey = c.get("apiKey");
    const identifier =
      apiKey?.id ?? getClientIp(c, config.trustedProxyCidrs) ?? "anon";
    const path = c.req.path;

    let limit = config.defaultLimit;
    let matchedPrefix: string | null = null;
    for (const [prefix, pathLimit] of Object.entries(config.pathLimits)) {
      if (path.startsWith(prefix)) {
        limit = pathLimit;
        matchedPrefix = prefix;
        break;
      }
    }

    // More generous for read-heavy endpoints
    if (c.req.method === "GET" && limit === config.defaultLimit) {
      limit = config.defaultLimit * 2;
    }

    // Window key: when a specific path-limit matched, scope the per-credential
    // window to that exact prefix so sibling endpoints under the same coarse
    // group get independent buckets. Otherwise a storm on one auth endpoint
    // (e.g. /auth/oauth2/token) would exhaust the shared `/auth` window and
    // 429 every other auth endpoint (sign-up, /authorize) for that caller.
    // The `all:<identifier>` aggregate window below still caps total spend, so
    // finer per-path keys can't be used to multiply a caller's overall budget.
    const pathPrefix = matchedPrefix ?? path.split("/").slice(0, 2).join("/");
    const credentialWindowKey = `${identifier}:${pathPrefix}`;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // All applicable windows increment in ONE statement — same table,
    // same timestamp, previously three sequential round trips on every
    // request. One deliberate semantic shift rides along: a request any
    // earlier cap rejects still counts against the later windows (and
    // reaches the per-space ceiling lookup), where before a rejection
    // stopped the chain. The request did arrive, so counting it is the
    // honest reading, and a client hammering one tightly-capped path now
    // exhausts its own aggregate budget too — deliberate backpressure.
    // The trade to know about: rejected traffic on a 30/min auth path
    // can now reach the aggregate cap, so on a deployment that has NOT
    // set TRUSTED_PROXY_CIDRS behind a proxy (where every anonymous
    // caller collapses onto one identifier) one abuser's rejections can
    // 429 the shared identifier everywhere. Configured proxy trust keeps
    // identifiers per-client and the blast radius the abuser's own.
    const spaceId = apiKey?.space_id;
    const spaceLimitValue = spaceId ? await spaceRateLimit(spaceId, now) : null;
    const aggregateWindowKey = `all:${identifier}`;
    const spaceWindowKey = spaceId ? `space:${spaceId}` : null;
    const windowKeys = [credentialWindowKey];
    if (aggregateLimit > 0) windowKeys.push(aggregateWindowKey);
    if (spaceWindowKey && spaceLimitValue !== null)
      windowKeys.push(spaceWindowKey);
    const windows = await config.storage.rateLimits.incrementWindows(
      RATE_FAMILY,
      windowKeys,
      config.windowMs,
      nowIso,
    );

    const rejectOver = (
      result: { count: number; expires_at: string } | undefined,
      cap: number,
      message: string,
    ): void => {
      if (!result || result.count <= cap) return;
      const retryAfter = Math.ceil(
        (new Date(result.expires_at).getTime() - now) / 1000,
      );
      c.header("Retry-After", String(retryAfter));
      throw new MarfaError(
        ErrorCode.RATE_LIMITED,
        `${message}. Try again in ${String(retryAfter)} seconds`,
      );
    };

    // The credential window is unconditionally in the batch, so a miss
    // is an impossible state — and rate limiting is a security control,
    // so an impossible state fails loud rather than silently skipping
    // the cap and the X-RateLimit-* trio.
    const credentialResult = windows.get(credentialWindowKey);
    if (!credentialResult) {
      throw new Error(
        "rateLimits.incrementWindows: batch missed the credential window",
      );
    }
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
    rejectOver(credentialResult, limit, "Rate limit exceeded");

    // Aggregate per-identifier window — keyed on the identifier with NO
    // path split — so a caller can't multiply its budget by spreading
    // traffic across path groups, and space-less identifiers (IP/anon,
    // the operator key) still hit a ceiling.
    if (aggregateLimit > 0) {
      rejectOver(
        windows.get(aggregateWindowKey),
        aggregateLimit,
        "Rate limit exceeded",
      );
    }

    // Per-space ceiling on top of the per-credential window. A noisy
    // single credential is bounded by the cap above; a space's
    // collective fleet is bounded here. Skipped for a space-less key, which
    // is the operator key and has no space to charge.
    if (spaceWindowKey && spaceLimitValue !== null) {
      rejectOver(
        windows.get(spaceWindowKey),
        spaceLimitValue,
        "Space rate limit exceeded",
      );
    }

    await next();
  };
}
