/**
 * Exponential backoff with jitter for shape stream reconnects.
 *
 * Mirrors the Swift SDK's reconnect schedule: base 1 s, cap 30 s,
 * exponential 2^(n-1) for consecutive fast-fails (error + 0 events
 * consumed), ±20% jitter to desynchronise client wake-ups.
 *
 * This is exported as a pure function so unit tests can verify the
 * schedule without spinning up Electric or PGlite.
 */

export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 30_000;
const JITTER_PCT = 0.2;

export function nextReconnectDelay(
  fastFailures: number,
  rng: () => number = Math.random,
): number {
  if (fastFailures <= 0) return 0;
  // 2^(n-1): 0 -> n/a, 1 -> 1×, 2 -> 2×, 3 -> 4×, ...
  const factor = Math.pow(2, Math.max(0, fastFailures - 1));
  const raw = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * factor);
  // Jitter: scale by [1-J, 1+J].
  const jitter = (rng() * 2 - 1) * JITTER_PCT;
  return Math.max(0, Math.round(raw * (1 + jitter)));
}

/**
 * Track consecutive fast-fail counts. A "fast fail" is a stream that
 * closes with an error before consuming any events. A "healthy close"
 * (events flowed, then the stream ended) resets the counter.
 */
export class ReconnectCounter {
  private fastFailures = 0;

  /** Record a fast-fail; returns the new count. */
  recordFastFailure(): number {
    return ++this.fastFailures;
  }

  /** Reset on healthy close. */
  recordHealthy(): void {
    this.fastFailures = 0;
  }

  get count(): number {
    return this.fastFailures;
  }
}
