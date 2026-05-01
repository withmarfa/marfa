/**
 * In-memory implementation of the subset of `DurableObjectStorage` the
 * runtime SDK uses. Sufficient for `PerConnectionStateCore`, the cursor
 * store, the echo-suppression helper, and the queue consumer's
 * `storageFor()` callback.
 *
 * This is the test-time replacement for the Workers SQLite-backed
 * storage. The keying + values match the production schema exactly so
 * a handler tested against this storage will behave identically when
 * promoted to a real DO.
 */
import type { CursorStorageAdapter } from "@mymehq/runtime-sdk";

export interface InMemoryStorage extends CursorStorageAdapter {
  list(options?: {
    prefix?: string;
    limit?: number;
  }): Promise<Map<string, unknown>>;
  /** Test-only — direct snapshot of the backing map. */
  snapshot(): ReadonlyMap<string, unknown>;
  /** Test-only — wipe the backing map. */
  reset(): void;
}

export function createInMemoryStorage(): InMemoryStorage {
  const data = new Map<string, unknown>();
  return {
    get(key: string): Promise<unknown> {
      return Promise.resolve(data.get(key));
    },
    put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      return Promise.resolve(data.delete(key));
    },
    list(options?: {
      prefix?: string;
      limit?: number;
    }): Promise<Map<string, unknown>> {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? Number.POSITIVE_INFINITY;
      const out = new Map<string, unknown>();
      for (const [k, v] of data) {
        if (out.size >= limit) break;
        if (k.startsWith(prefix)) out.set(k, v);
      }
      return Promise.resolve(out);
    },
    snapshot(): ReadonlyMap<string, unknown> {
      return new Map(data);
    },
    reset(): void {
      data.clear();
    },
  };
}
