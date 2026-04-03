import type { MiddlewareHandler } from "hono";
import { ProtocolError, ErrorCode } from "@myme/shared";
import type { AppEnv } from "./auth.js";

interface RateLimitConfig {
  /** Default requests per window (default: 100) */
  defaultLimit: number;
  /** Window size in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
  /** Stricter limits by path prefix */
  pathLimits: Record<string, number>;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  defaultLimit: Number(process.env.RATE_LIMIT_REQUESTS) || 100,
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  pathLimits: {
    "/keys": 10,
    "/auth/token": 20,
  },
};

/**
 * In-memory sliding window rate limiter.
 * Keys by API key ID (or IP for unauthenticated requests).
 * Path-specific limits for sensitive endpoints.
 */
export function rateLimitMiddleware(
  config: RateLimitConfig = DEFAULT_CONFIG,
): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, WindowEntry>();

  // Periodic cleanup of expired entries — single interval per middleware instance
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (entry.resetAt <= now) {
        windows.delete(key);
      }
    }
  }, config.windowMs * 2);
  cleanupInterval.unref();

  // Expose cleanup for graceful shutdown
  (
    cleanupInterval as unknown as { _rateLimitCleanup: true }
  )._rateLimitCleanup = true;

  return async (c, next) => {
    const apiKey = c.get("apiKey");
    const identifier = apiKey?.id ?? c.req.header("x-forwarded-for") ?? "anon";
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

    const windowKey = `${identifier}:${path.split("/").slice(0, 2).join("/")}`;
    const now = Date.now();

    let entry = windows.get(windowKey);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + config.windowMs };
      windows.set(windowKey, entry);
    }

    entry.count++;

    // Set rate limit headers
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      throw new ProtocolError(
        ErrorCode.RATE_LIMITED,
        `Rate limit exceeded. Try again in ${String(retryAfter)} seconds`,
      );
    }

    await next();
  };
}
