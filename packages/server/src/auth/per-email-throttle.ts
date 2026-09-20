/**
 * Per-email throttle for password-reset (and similar email-keyed)
 * requests.
 *
 * The counter lives in `storage.rateLimits`, so every process pointed at
 * the database throttles an address together rather than each holding its
 * own count.
 *
 * Sits on top of the per-IP rate limit (`middleware/rate-limit.ts`).
 * Per-IP bounds noisy clients; per-email bounds the address itself —
 * a burst from many IPs cannot drown a single user's inbox in reset
 * emails.
 *
 * Defaults: 3 requests per email per 1-hour rolling window. The
 * counter ALWAYS increments on `attempt()` — including over-cap
 * attempts. Once `count > limit`, requests are rejected until the
 * window rolls over.
 */

import type { Storage } from "../storage/interface.js";

export interface ThrottleResult {
  /** `true` if the request is allowed. `false` if the cap has been hit. */
  allowed: boolean;
  /** Current count after this attempt — including over-cap counts. */
  count: number;
  /** Cap applied. */
  limit: number;
  /** Epoch-ms when the window resets. */
  resetAt: number;
}

export interface PerEmailThrottleOptions {
  /**
   * Family discriminator on the underlying `rate_limit_windows` table.
   * One-per-surface so windows are independent: forgot-password vs.
   * (future) magic-link, etc. Defaults to `"throttle"`.
   */
  family?: string;
  /** Key prefix prepended to the (lowercased) email. Defaults to
   *  `"forgot-password:"`. */
  keyPrefix?: string;
  /** Max requests per window per email. Default: 3. */
  limit?: number;
  /** Window length in ms. Default: 1 hour. */
  windowMs?: number;
}

/**
 * Per-email throttle that mints `ThrottleResult`s. Construct one per
 * surface (forgot-password, magic-link, etc.) so the windows are
 * independent. Email is lowercased before keying so casing doesn't
 * defeat the cap.
 */
export class PerEmailThrottle {
  private readonly family: string;
  private readonly keyPrefix: string;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(
    private storage: Storage,
    options: PerEmailThrottleOptions = {},
  ) {
    this.family = options.family ?? "throttle";
    this.keyPrefix = options.keyPrefix ?? "forgot-password:";
    this.limit = options.limit ?? 3;
    this.windowMs = options.windowMs ?? 60 * 60 * 1000;
  }

  /**
   * Record an attempt against `email` and return whether it's allowed.
   * Increments the underlying counter on every call (the store's upsert
   * is unconditional); the gate is `count > limit` on the caller side.
   * The caller decides whether to act on a `false` result (typically:
   * 429 + soft-fail redirect).
   *
   * `nowIso` is the per-call clock; defaults to `new Date().toISOString()`.
   * Tests pass a deterministic value.
   */
  async attempt(
    email: string,
    nowIso = new Date().toISOString(),
  ): Promise<ThrottleResult> {
    const key = `${this.keyPrefix}${email.toLowerCase()}`;
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
}
