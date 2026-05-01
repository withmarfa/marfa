/**
 * In-memory Queue producer + consumer for tests.
 *
 * Cloudflare's QueueProducer exposes `send(message, opts)` and the
 * consumer receives messages via the Worker's `queue(batch, env, ctx)`
 * handler. This shim:
 *   - implements the producer-side `send` (just appends to a list)
 *   - exposes `drain()` which returns the accumulated messages so
 *     tests can pass them straight to `consumeBatch` from the SDK.
 *
 * Tests typically pair this with `consumeBatch(env, queue.drain())`
 * to simulate a complete enqueue → consume round trip.
 */
export interface InMemoryQueue<T = unknown> {
  send(body: T, opts?: { contentType?: "json" | "text" | "v8" }): Promise<void>;
  /** Test-only — returns and clears the buffered messages. */
  drain(): T[];
  /** Test-only — peek without clearing. */
  peek(): readonly T[];
  /** Test-only — number of messages buffered. */
  size(): number;
}

export function createInMemoryQueue<T = unknown>(): InMemoryQueue<T> {
  const buffer: T[] = [];
  return {
    send(body: T): Promise<void> {
      buffer.push(body);
      return Promise.resolve();
    },
    drain(): T[] {
      const out = buffer.splice(0, buffer.length);
      return out;
    },
    peek(): readonly T[] {
      return buffer;
    },
    size(): number {
      return buffer.length;
    },
  };
}
