/**
 * A counter per key over a fixed window, for the doors that limit something
 * other than the caller's credential: an account being signed in to, an
 * address entering device codes, the instance as a whole.
 *
 * The counter lives in `storage.rateLimits`, so every process pointed at the
 * database counts a key together rather than each holding its own count.
 *
 * Every `attempt()` counts, over-cap attempts included, and the answer comes
 * from the same statement that counted it. That is why a door asks before it
 * does the work it is limiting rather than counting failures afterwards: a
 * check made apart from the count lets a burst of concurrent requests all
 * pass the check before any of them is counted.
 */

import type { Storage } from "../storage/interface.js";
import * as clock from "../clock.js";

export interface ThrottleResult {
  /** `true` if the request is allowed. `false` if the cap has been hit. */
  allowed: boolean;
  /** Current count after this attempt, over-cap attempts included. */
  count: number;
  /** Cap applied. */
  limit: number;
  /** Epoch-ms when the window resets. */
  resetAt: number;
}

export interface KeyedThrottleOptions {
  /** The family on the `rate_limit_windows` table, one per throttle, so two
   *  throttles counting the same key keep separate windows. */
  family: string;
  /** Attempts allowed per key per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Whole seconds until a window that resets at `resetAt` (epoch-ms) allows
 * another attempt, never less than one: this is what `Retry-After` carries and
 * what the pages turn into minutes.
 */
export function secondsUntilReset(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - clock.nowMs()) / 1000));
}

/** What the next attempt on a key would meet. */
export type ThrottlePeek =
  { allowed: true } | { allowed: false; resetAt: number };

export class KeyedThrottle {
  private readonly family: string;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(
    private storage: Storage,
    options: KeyedThrottleOptions,
  ) {
    this.family = options.family;
    this.limit = options.limit;
    this.windowMs = options.windowMs;
  }

  /**
   * Count an attempt against `key` and say whether it is allowed. The key is
   * used as given, so a caller normalizes it first (an address lowercased, an
   * IPv6 address reduced to its prefix).
   *
   * `nowIso` is the per-call clock; tests pass a deterministic value.
   */
  async attempt(
    key: string,
    nowIso = clock.now().toISOString(),
  ): Promise<ThrottleResult> {
    const row = await this.storage.rateLimits.incrementWindow(
      this.family,
      key,
      this.windowMs,
      nowIso,
    );
    return {
      allowed: row.count <= this.limit,
      count: row.count,
      limit: this.limit,
      resetAt: new Date(row.expires_at).getTime(),
    };
  }

  /**
   * Say whether the next attempt on `key` would be refused, and when its
   * window ends, without counting an attempt.
   */
  async peek(
    key: string,
    nowIso = clock.now().toISOString(),
  ): Promise<ThrottlePeek> {
    const row = await this.storage.rateLimits.peekWindow(
      this.family,
      key,
      nowIso,
    );
    if (!row || row.count < this.limit) return { allowed: true };
    return { allowed: false, resetAt: new Date(row.expires_at).getTime() };
  }
}

/**
 * Count an attempt against each lane in order, stopping at the first that
 * refuses it, so a refused attempt spends none of the lanes after it. When a
 * lane refuses, the lanes after it are read without counting, and the answer
 * is the latest end among every lane that would refuse the next attempt,
 * including a lane before it that this attempt brought to its cap: that is
 * when another attempt will be allowed.
 */
export async function admitThroughLanes(
  lanes: readonly { throttle: KeyedThrottle; key: string }[],
): Promise<{ allowed: true } | { allowed: false; resetAt: number }> {
  let resetAt: number | undefined;
  let spentEnd = 0;
  for (const { throttle, key } of lanes) {
    if (resetAt === undefined) {
      const attempt = await throttle.attempt(key);
      if (!attempt.allowed) resetAt = Math.max(attempt.resetAt, spentEnd);
      else if (attempt.count >= attempt.limit)
        spentEnd = Math.max(spentEnd, attempt.resetAt);
      continue;
    }
    const peek = await throttle.peek(key);
    if (!peek.allowed) resetAt = Math.max(resetAt, peek.resetAt);
  }
  return resetAt === undefined
    ? { allowed: true }
    : { allowed: false, resetAt };
}
