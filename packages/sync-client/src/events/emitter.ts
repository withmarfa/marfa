import type {
  SyncEventEnvelope,
  SyncEventMap,
  SyncEventName,
} from "./types.js";

type Listener<K extends SyncEventName> = (payload: SyncEventMap[K]) => void;

/**
 * Minimal, typed event emitter with both callback-style and AsyncIterable
 * subscription. Avoids pulling in `events` from Node so the package
 * stays browser-friendly.
 */
export class SyncEventEmitter {
  private listeners = new Map<SyncEventName, Set<Listener<SyncEventName>>>();
  private streamSinks = new Set<
    (envelope: SyncEventEnvelope<SyncEventName>) => void
  >();

  on<K extends SyncEventName>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<SyncEventName>);
    return () => {
      set?.delete(listener as Listener<SyncEventName>);
    };
  }

  emit<K extends SyncEventName>(event: K, payload: SyncEventMap[K]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          (fn as Listener<K>)(payload);
        } catch {
          // Listeners must not break the emitter. Errors are intentionally
          // swallowed; the consumer can wrap their own handler if they
          // care about reporting.
        }
      }
    }
    const envelope: SyncEventEnvelope<K> = { type: event, payload };
    for (const sink of this.streamSinks) {
      try {
        sink(envelope as SyncEventEnvelope<SyncEventName>);
      } catch {
        // ditto
      }
    }
  }

  /**
   * AsyncIterable subscription. Each iterator gets every event emitted
   * after subscription — late subscribers do not see history. Mirrors
   * the Swift SDK's `events: AsyncStream<SyncEvent>` shape.
   */
  events(): AsyncIterableIterator<SyncEventEnvelope<SyncEventName>> {
    const queue: SyncEventEnvelope<SyncEventName>[] = [];
    let resolveNext: ((value: SyncEventEnvelope<SyncEventName>) => void) | null =
      null;

    const sink = (env: SyncEventEnvelope<SyncEventName>) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(env);
        return;
      }
      queue.push(env);
    };
    this.streamSinks.add(sink);

    const iterator: AsyncIterableIterator<SyncEventEnvelope<SyncEventName>> = {
      next: () => {
        if (queue.length > 0) {
          const env = queue.shift();
          if (env) return Promise.resolve({ value: env, done: false });
        }
        return new Promise((resolve) => {
          resolveNext = (env) => {
            resolve({ value: env, done: false });
          };
        });
      },
      return: () => {
        this.streamSinks.delete(sink);
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (err) => {
        this.streamSinks.delete(sink);
        return Promise.reject(err);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return iterator;
  }
}
