/**
 * In-memory Queue producer + consumer for tests.
 *
 * Cloudflare's QueueProducer exposes `send(message, opts)` and the
 * consumer receives messages via the Worker's `queue(batch, env, ctx)`
 * handler. This shim:
 *   - implements the producer-side `send` (just appends to a list)
 *   - exposes `drain()` which returns the accumulated payloads so
 *     tests can pass them straight to the SDK's `consumeBatch`
 *   - exposes `drainMessages()` which returns the same payloads wrapped
 *     in Cloudflare-shaped `Message<T>` envelopes — `body`, `ack()`,
 *     `retry({ delaySeconds })`, `attempts` — plus the test-only
 *     `acked()` / `retried()` introspection helpers.
 *
 * The two drains coexist deliberately: `drain()` returns raw payloads
 * for simpler tests; `drainMessages()` returns per-message envelopes
 * for tests that need to assert "message #2 was retried, #1 + #3
 * acked".
 */

/**
 * Test-shaped envelope mirroring Cloudflare Queues' `Message` interface
 * for per-message ack/retry. Each enqueued payload is wrapped in one of
 * these on `drainMessages()`. Cloudflare adds more fields on the real
 * runtime (`id`, `timestamp`); the test harness only needs the shape
 * the SDK consumer interacts with.
 *
 * **Lifecycle.** A fresh envelope reports `acked() === false`,
 * `retried() === false`, `attempts === 1`. Calling `ack()` flips
 * `acked()` to true. Calling `retry()` flips `retried()` to true and
 * bumps `attempts`. Either method is idempotent — calling `ack()` twice
 * doesn't double-count, and a redelivered envelope's `attempts` is the
 * running total.
 */
export interface Message<T> {
  /**
   * Cloudflare assigns a unique id per delivery. The harness produces a
   * stable `msg_<random>` so test assertions can correlate envelopes
   * with later inspection of mocks. Real Workers expose this as readonly.
   */
  readonly id: string;
  /** Cloudflare timestamps every delivery. The harness stamps the
   *  `Date.now()` at envelope construction. */
  readonly timestamp: Date;
  /** The original payload as enqueued via `q.send(...)`. */
  readonly body: T;
  /**
   * Cloudflare-runtime delivery counter. Starts at 1 on first delivery;
   * `retry()` does not surface a new envelope here (this harness is
   * single-pass) — `attempts` is bumped synchronously so the consumer's
   * exponential-backoff math still works on the post-retry envelope if
   * the test wants to inspect it.
   */
  readonly attempts: number;

  /**
   * Mark this message as successfully processed. Mirrors Cloudflare's
   * `Message.ack()`. Idempotent — extra calls are no-ops.
   */
  ack(): void;

  /**
   * Schedule this message for redelivery after the optional delay. The
   * harness doesn't actually re-enqueue (single-pass); it tracks that
   * `retry()` was called so tests can assert "this message was
   * retried, that one was acked." The optional `delaySeconds` is
   * captured for assertion-side use.
   */
  retry(opts?: { delaySeconds?: number }): void;

  // ---- test introspection (not part of Cloudflare's surface) ----

  /** Test helper — has `ack()` been called? */
  acked(): boolean;
  /** Test helper — has `retry()` been called? */
  retried(): boolean;
  /** Test helper — the most recent `delaySeconds` passed to `retry()`. */
  retryDelaySeconds(): number | undefined;
}

export interface InMemoryQueue<T = unknown> {
  send(body: T, opts?: { contentType?: "json" | "text" | "v8" }): Promise<void>;
  /** Test-only — returns and clears the buffered payloads (unwrapped).
   *  Use when the test only needs raw bodies, not per-message tracking. */
  drain(): T[];
  /**
   * Test-only — returns and clears the buffered payloads wrapped in
   * `Message<T>` envelopes. Use this when the test needs to assert
   * per-message ack/retry outcomes.
   */
  drainMessages(): Message<T>[];
  /** Test-only — peek at buffered payloads without clearing. */
  peek(): readonly T[];
  /** Test-only — number of payloads buffered. */
  size(): number;
}

/**
 * Build a `Message<T>` envelope around a single payload. Exposed
 * separately from `createInMemoryQueue` so tests that want to construct
 * messages outside the queue (e.g. to feed a partial batch into a
 * future per-message-ack `consumeBatch` directly) have a single source
 * of truth for the envelope shape.
 *
 * `attempts` defaults to 1 (first delivery). Pass a higher value to
 * simulate a redelivered message.
 */
export function createMessage<T>(body: T, attempts = 1): Message<T> {
  let acked = false;
  let retried = false;
  let retryDelaySeconds: number | undefined;
  let currentAttempts = attempts;
  // Stable-ish ids so tests can correlate envelopes with mocks.
  const id = `msg_${Math.random().toString(36).slice(2, 14)}`;
  const timestamp = new Date();
  return {
    id,
    timestamp,
    body,
    get attempts() {
      return currentAttempts;
    },
    ack(): void {
      acked = true;
    },
    retry(opts?: { delaySeconds?: number }): void {
      retried = true;
      retryDelaySeconds = opts?.delaySeconds;
      // Keep `attempts` consistent with the redelivered-envelope shape.
      // The harness is single-pass so the bump only matters for
      // assertions; the message isn't re-enqueued.
      currentAttempts++;
    },
    acked(): boolean {
      return acked;
    },
    retried(): boolean {
      return retried;
    },
    retryDelaySeconds(): number | undefined {
      return retryDelaySeconds;
    },
  };
}

export function createInMemoryQueue<T = unknown>(): InMemoryQueue<T> {
  const buffer: T[] = [];
  return {
    send(body: T): Promise<void> {
      buffer.push(body);
      return Promise.resolve();
    },
    drain(): T[] {
      return buffer.splice(0, buffer.length);
    },
    drainMessages(): Message<T>[] {
      const drained = buffer.splice(0, buffer.length);
      return drained.map((payload) => createMessage(payload));
    },
    peek(): readonly T[] {
      return buffer;
    },
    size(): number {
      return buffer.length;
    },
  };
}
