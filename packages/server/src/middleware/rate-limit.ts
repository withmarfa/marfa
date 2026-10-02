import type { MiddlewareHandler } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { addressBucket } from "./client-ip.js";
import type { Storage } from "../storage/interface.js";

export interface RateLimitConfig {
  /** Default requests per window. */
  defaultLimit: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Stricter limits by path prefix */
  pathLimits: Record<string, number>;
  /**
   * Required storage handle. The rate-limit counter lives in the shared
   * store (`storage.rateLimits`).
   */
  storage: Storage;
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
 * The counter table sits in the same database every other table lives in,
 * so every process pointed at it increments the same rows and the cap
 * holds across all of them rather than per process.
 *
 * Hot path: one upsert round-trip per gated request. The shared
 * `rate_limit_windows` rows have their own retention sweep
 * (`RateLimitWindowCleaner` in storage/retention.ts).
 *
 * Configuration is required — there is no fallback that reads
 * `process.env`. `app.ts` constructs the config from `AppConfig`.
 */
const RATE_FAMILY = "rate";

export function rateLimitMiddleware(
  config: RateLimitConfig,
): MiddlewareHandler<AppEnv> {
  // Aggregate per-identifier cap = defaultLimit * multiplier. The per-path
  // window below is keyed on `(identifier, pathPrefix)`, so an identifier's
  // effective budget multiplies across every path group it touches. The
  // aggregate window keys on the identifier ALONE (no path split) to bound
  // that total. The multiplier keeps the per-path window the primary cap
  // most callers hit, with the aggregate as a backstop. `0` disables it
  // (legacy per-path-only behavior).
  const aggregateMultiplier =
    config.aggregateMultiplier ?? DEFAULT_AGGREGATE_MULTIPLIER;
  const aggregateLimit =
    aggregateMultiplier > 0 ? config.defaultLimit * aggregateMultiplier : 0;

  return async (c, next) => {
    const apiKey = c.get("apiKey");
    // The address `clientIpMiddleware` resolved, which has to run first.
    const clientIp = c.var.clientIp;
    const identifier =
      apiKey?.id ?? (clientIp ? addressBucket(clientIp) : null) ?? "anon";
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

    // More generous for read-heavy endpoints, and only where no path cap
    // was chosen. The condition is the absence of a match rather than
    // `limit === config.defaultLimit`, which says the same thing only
    // while no path's cap happens to equal the default: a deployment
    // that set `RATE_LIMIT_KEYS_REQUESTS` to the default would otherwise
    // have its key reads judged against twice the number it asked for,
    // and the header would name the doubled one.
    if (c.req.method === "GET" && matchedPrefix === null) {
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

    // Both windows increment in ONE statement — same table, same
    // timestamp, previously sequential round trips on every request. One
    // deliberate semantic shift rides along: a request the per-path cap
    // rejects still counts against the aggregate window, where before a
    // rejection stopped the chain. The request did arrive, so counting it
    // is the honest reading, and a client hammering one tightly-capped
    // path now exhausts its own aggregate budget too — deliberate
    // backpressure.
    // The trade to know about: rejected traffic on a 30/min auth path
    // can now reach the aggregate cap, so on a deployment that has NOT
    // set TRUSTED_PROXY_CIDRS behind a proxy (where every anonymous
    // caller collapses onto one identifier) one abuser's rejections can
    // 429 the shared identifier everywhere. Configured proxy trust keeps
    // identifiers per-client and the blast radius the abuser's own.
    const aggregateWindowKey = `all:${identifier}`;
    const windowKeys = [credentialWindowKey];
    if (aggregateLimit > 0) windowKeys.push(aggregateWindowKey);
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
    // traffic across path groups.
    if (aggregateLimit > 0) {
      rejectOver(
        windows.get(aggregateWindowKey),
        aggregateLimit,
        "Rate limit exceeded",
      );
    }

    await next();
  };
}
