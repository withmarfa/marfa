import { setTimeout as delay } from "node:timers/promises";
import type { MiddlewareHandler } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { credentialHandle } from "./auth.js";
import type { Storage } from "../storage/interface.js";
import { runInBackground } from "../background-context.js";
import * as clock from "../clock.js";
import { withoutWriteWait } from "../storage/sqlite/connection.js";

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
 * Hot path: one upsert per gated request, in a write transaction that never
 * waits for the lock (`WindowLedger` below says what happens when it is
 * held). The shared `rate_limit_windows` rows have their own retention sweep
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
    // The address `clientIpMiddleware` resolved, which has to run first.
    const identifier = credentialHandle(c) || (c.var.clientIp ?? "anon");
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
    const now = clock.nowMs();

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
    const windows = await ledgerFor(config.storage).count(
      windowKeys,
      config.windowMs,
      now,
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

interface Window {
  count: number;
  expires_at: string;
}

const LEDGER_KEYS_MAX = 32_768;
const SETTLE_RETRY_MS = 1_000;

function lockWasHeld(err: unknown): boolean {
  for (let step: unknown = err, depth = 0; depth < 8; depth++) {
    if (step instanceof MarfaError)
      return step.code === ErrorCode.WRITE_CONTENTION;
    if (step === null || typeof step !== "object") return false;
    step = (step as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The windows as this process last knew them, and the requests it counted
 * while it could not write them.
 *
 * Counting a request is a write, and a request must not wait for the write
 * lock to be counted: an atomic bulk page holds the lock for as long as it
 * runs, and every request behind it would wait with it, or be refused
 * `write_contention` once the busy budget had passed. So the increment
 * never waits. When the lock is held, the request is judged against the
 * count this process last read plus what it has counted since, and the
 * shared window is paid once the lock is free. Another process sees those
 * requests only then.
 */
class WindowLedger {
  private readonly known = new Map<string, Window>();
  private readonly owed = new Map<string, Window>();
  private settling: Promise<void> | undefined;

  constructor(private readonly storage: Storage) {}

  async count(
    keys: string[],
    windowMs: number,
    now: number,
  ): Promise<Map<string, Window>> {
    let stored: Map<string, Window>;
    try {
      stored = await withoutWriteWait(() =>
        this.storage.runInTransaction(() =>
          this.storage.rateLimits.incrementWindows(
            RATE_FAMILY,
            keys,
            windowMs,
            new Date(now).toISOString(),
          ),
        ),
      );
    } catch (error) {
      if (!lockWasHeld(error)) throw error;
      return this.countHere(keys, windowMs, now);
    }
    const counted = new Map<string, Window>();
    for (const [key, window] of stored) {
      const debt = this.owed.get(key);
      counted.set(
        key,
        this.remember(key, {
          count: window.count + (debt?.count ?? 0),
          expires_at: window.expires_at,
        }),
      );
    }
    return counted;
  }

  /** Waits until nothing counted here is still owed to the shared windows. */
  async settled(): Promise<void> {
    while (this.settling) await this.settling;
  }

  private countHere(
    keys: string[],
    windowMs: number,
    now: number,
  ): Map<string, Window> {
    const nowIso = new Date(now).toISOString();
    const counted = new Map<string, Window>();
    for (const key of new Set(keys)) {
      const last = this.known.get(key);
      const window =
        last && last.expires_at > nowIso
          ? { count: last.count + 1, expires_at: last.expires_at }
          : { count: 1, expires_at: new Date(now + windowMs).toISOString() };
      const debt = this.owed.get(key);
      if (debt && debt.expires_at > nowIso) debt.count += 1;
      else if (this.owed.size < LEDGER_KEYS_MAX)
        this.owed.set(key, { count: 1, expires_at: window.expires_at });
      counted.set(key, this.remember(key, window));
    }
    this.settle(windowMs);
    return counted;
  }

  private remember(key: string, window: Window): Window {
    this.known.delete(key);
    this.known.set(key, window);
    if (this.known.size > LEDGER_KEYS_MAX) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
    return window;
  }

  private settle(windowMs: number): void {
    this.settling ??= runInBackground(async () => {
      try {
        while (this.owed.size) {
          await delay(SETTLE_RETRY_MS, undefined, { ref: false });
          const nowIso = clock.now().toISOString();
          // A window that has ended is not paid into the one after it.
          for (const [key, debt] of this.owed)
            if (debt.expires_at <= nowIso) this.owed.delete(key);
          const paying = [...this.owed].map(
            ([key, debt]) => [key, debt.count] as const,
          );
          if (paying.length === 0) break;
          try {
            await withoutWriteWait(() =>
              this.storage.runInTransaction(async () => {
                for (const [key, count] of paying)
                  for (let i = 0; i < count; i++)
                    await this.storage.rateLimits.incrementWindows(
                      RATE_FAMILY,
                      [key],
                      windowMs,
                      nowIso,
                    );
              }),
            );
          } catch (error) {
            if (lockWasHeld(error)) continue;
            // A store that cannot be written is not waited on by a worker.
            this.owed.clear();
            break;
          }
          for (const [key, count] of paying) {
            const debt = this.owed.get(key);
            if (!debt) continue;
            debt.count -= count;
            if (debt.count <= 0) this.owed.delete(key);
          }
        }
      } finally {
        this.settling = undefined;
      }
    });
  }
}

const ledgers = new WeakMap<Storage, WindowLedger>();

function ledgerFor(storage: Storage): WindowLedger {
  let ledger = ledgers.get(storage);
  if (!ledger) {
    ledger = new WindowLedger(storage);
    ledgers.set(storage, ledger);
  }
  return ledger;
}

/** Waits until every request counted while the lock was held is in the shared windows. */
export async function settleRateLimits(storage: Storage): Promise<void> {
  await ledgers.get(storage)?.settled();
}
