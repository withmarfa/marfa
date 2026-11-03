import { setImmediate, setTimeout as delay } from "node:timers/promises";
import type { MiddlewareHandler } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { credentialHandle } from "./auth.js";
import type { Storage } from "../storage/interface.js";
import { runInBackground } from "../background-context.js";
import * as clock from "../clock.js";
import { lockNotFree, withoutWriteWait } from "../storage/sqlite/connection.js";

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
 * so the counts outlive a restart.
 *
 * Hot path: one upsert per gated request, in a write transaction that never
 * waits for the lock (`WindowLedger` below says what happens when it is
 * held, and what that costs). The shared `rate_limit_windows` rows have their own retention sweep
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

const HELD_KEYS_MAX = 32_768;
const SETTLE_RETRY_MS = 1_000;
const SETTLE_KEYS_PER_STATEMENT = 500;

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
 * Counts requests against the shared windows without waiting for the write
 * lock: an atomic bulk page holds the lock for as long as it runs, and every
 * request behind it would wait with it, or be refused `write_contention`
 * once the busy budget had passed.
 *
 * With the lock free, a request is added to its windows in one statement,
 * together with the requests held back for them, and judged on the counts
 * that statement returns. With the lock held, it is judged on the shared
 * window as it stands, which a read gets without waiting under WAL, plus the
 * requests this process has held back for that window, plus itself, and is
 * held back in turn. Counts run one at a time, so every counted request is
 * in exactly one of the shared row and `held` whenever a count reads them.
 *
 * Within one process that is the cap exactly. Held requests are written
 * about a second after the lock frees, or by the next count of their window.
 * Until then they live only in this process's memory: if it exits, they are
 * lost, and the caller may make that many more requests in the same window,
 * at most one more limit's worth. Another process using the same database
 * does not see them until they are written.
 *
 * The count runs outside the request's authority, as the single statement it
 * replaces did: it writes only the limiter's own rows.
 */
class WindowLedger {
  private readonly held = new Map<string, Window>();
  private queue: Promise<unknown> = Promise.resolve();
  private settling: Promise<void> | undefined;

  constructor(private readonly storage: Storage) {}

  count(
    keys: string[],
    windowMs: number,
    now: number,
  ): Promise<Map<string, Window>> {
    return this.alone(() => this.countNow([...new Set(keys)], windowMs, now));
  }

  /** Waits until nothing counted here is still held back from the shared windows. */
  async settled(): Promise<void> {
    while (this.settling) await this.settling;
  }

  private alone<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(() => runInBackground(work));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** A held request whose window has ended counts in no later window. */
  private forgetEnded(nowIso: string): void {
    for (const [key, window] of this.held)
      if (window.expires_at <= nowIso) this.held.delete(key);
  }

  private async write(
    keys: string[],
    windowMs: number,
    nowIso: string,
    by: ReadonlyMap<string, Window>,
  ): Promise<Map<string, Window>> {
    return await withoutWriteWait(() =>
      this.storage.runInTransaction(() =>
        this.storage.rateLimits.incrementWindows(
          RATE_FAMILY,
          keys,
          windowMs,
          nowIso,
          by,
        ),
      ),
    );
  }

  private async countNow(
    keys: string[],
    windowMs: number,
    now: number,
  ): Promise<Map<string, Window>> {
    const nowIso = new Date(now).toISOString();
    this.forgetEnded(nowIso);
    const by = new Map<string, Window>();
    for (const key of keys) {
      const owed = this.held.get(key);
      if (owed)
        by.set(key, { count: owed.count + 1, expires_at: owed.expires_at });
    }
    let stored: Map<string, Window>;
    try {
      stored = await this.write(keys, windowMs, nowIso, by);
    } catch (error) {
      if (!lockWasHeld(error)) throw error;
      return await this.countHeld(keys, windowMs, now);
    }
    for (const key of keys) this.held.delete(key);
    return stored;
  }

  private async countHeld(
    keys: string[],
    windowMs: number,
    now: number,
  ): Promise<Map<string, Window>> {
    const nowIso = new Date(now).toISOString();
    const unheld = keys.filter((key) => !this.held.has(key)).length;
    // A request that could not be held back could not be judged on its
    // window either, so it meets the lock as any other write would.
    if (this.held.size + unheld > HELD_KEYS_MAX) throw lockNotFree();
    const counted = new Map<string, Window>();
    for (const key of keys) {
      const shared = await this.storage.rateLimits.peekWindow(
        RATE_FAMILY,
        key,
        nowIso,
      );
      const owed = this.held.get(key);
      counted.set(key, {
        count: (shared?.count ?? 0) + (owed?.count ?? 0) + 1,
        expires_at:
          shared?.expires_at ??
          owed?.expires_at ??
          new Date(now + windowMs).toISOString(),
      });
    }
    for (const [key, window] of counted) {
      const owed = this.held.get(key);
      if (owed) owed.count += 1;
      else this.held.set(key, { count: 1, expires_at: window.expires_at });
    }
    this.settle(windowMs);
    return counted;
  }

  private settle(windowMs: number): void {
    this.settling ??= runInBackground(async () => {
      try {
        while (this.held.size) {
          await delay(SETTLE_RETRY_MS, undefined, { ref: false });
          if (!(await this.alone(() => this.writeHeld(windowMs)))) break;
        }
      } finally {
        this.settling = undefined;
      }
    });
  }

  /** Whether to try again later: false once the store refuses for a reason
   *  other than the lock, whose held requests the next count writes instead. */
  private async writeHeld(windowMs: number): Promise<boolean> {
    const nowIso = clock.now().toISOString();
    this.forgetEnded(nowIso);
    const keys = [...this.held.keys()];
    for (let at = 0; at < keys.length; at += SETTLE_KEYS_PER_STATEMENT) {
      if (at > 0) await setImmediate();
      const chunk = keys.slice(at, at + SETTLE_KEYS_PER_STATEMENT);
      const by = new Map<string, Window>();
      for (const key of chunk) {
        const owed = this.held.get(key);
        if (owed) by.set(key, { ...owed });
      }
      try {
        await this.write(chunk, windowMs, nowIso, by);
      } catch (error) {
        return lockWasHeld(error);
      }
      for (const key of chunk) this.held.delete(key);
    }
    return true;
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

/** Waits until every request held back while the lock was held is in the shared windows. */
export async function settleRateLimits(storage: Storage): Promise<void> {
  await ledgers.get(storage)?.settled();
}
