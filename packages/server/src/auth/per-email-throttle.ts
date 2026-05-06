/**
 * In-memory per-email throttle for password-reset requests.
 *
 * Wave C PR3 / T-033. Sits on top of the per-IP rate limit
 * (`middleware/rate-limit.ts`). Per-IP bounds noisy clients; per-email
 * bounds the address itself — so a burst from many IPs can't drown a
 * single user's inbox in reset emails.
 *
 * Defaults: 3 requests per email per 1-hour rolling window. Old entries
 * are evicted lazily on next access; no background timer needed.
 *
 * Single-process in-memory only — multi-instance deployments would
 * need a Redis-backed shared counter to enforce globally. The hosted
 * Myme today is single-instance per tenant, so this is sufficient for
 * the launch surface.
 */

interface ThrottleEntry {
  /** Number of requests in the current window. */
  count: number;
  /** Epoch-ms when the window resets. */
  resetAt: number;
}

export interface ThrottleResult {
  /** `true` if the request is allowed. `false` if the cap has been hit. */
  allowed: boolean;
  /** Current count after this attempt (incremented on `allowed=true`). */
  count: number;
  /** Cap applied. */
  limit: number;
  /** Epoch-ms when the window resets. */
  resetAt: number;
}

export interface PerEmailThrottleOptions {
  /** Max requests per window per email. Default: 3. */
  limit?: number;
  /** Window length in ms. Default: 1 hour. */
  windowMs?: number;
}

/**
 * Per-email throttle that mints `ThrottleResult`s. Construct one per
 * surface (forgot-password, magic-link, etc.) so the windows are
 * independent.
 *
 * Email is normalised to lowercase before keying so casing doesn't
 * defeat the cap.
 */
export class PerEmailThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(options: PerEmailThrottleOptions = {}) {
    this.limit = options.limit ?? 3;
    this.windowMs = options.windowMs ?? 60 * 60 * 1000;
  }

  /**
   * Record an attempt against `email` and return whether it's allowed.
   * Increments the counter only on `allowed=true`. The caller decides
   * whether to act on a `false` result (typically: 429 + soft-fail).
   */
  attempt(email: string, now = Date.now()): ThrottleResult {
    const key = email.toLowerCase();
    const existing = this.entries.get(key);

    // Window expired — reset.
    if (!existing || existing.resetAt <= now) {
      const fresh: ThrottleEntry = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      this.entries.set(key, fresh);
      return {
        allowed: true,
        count: fresh.count,
        limit: this.limit,
        resetAt: fresh.resetAt,
      };
    }

    if (existing.count >= this.limit) {
      return {
        allowed: false,
        count: existing.count,
        limit: this.limit,
        resetAt: existing.resetAt,
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      count: existing.count,
      limit: this.limit,
      resetAt: existing.resetAt,
    };
  }

  /**
   * Test-only / operator-only reset. Drops the throttle state for the
   * given email (or all entries when omitted). Production callers
   * have no business clearing throttles, so this isn't surfaced on
   * the public API.
   */
  reset(email?: string): void {
    if (email === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(email.toLowerCase());
  }

  /** Diagnostics — current entry count. */
  size(): number {
    return this.entries.size;
  }
}
