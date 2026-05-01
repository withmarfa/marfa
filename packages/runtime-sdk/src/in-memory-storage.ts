/**
 * Minimal in-memory implementation of `CursorStorageAdapter` for unit
 * tests. The full @mymehq/runtime-test in-memory mocks (DO, Queues,
 * KV) ship in PR 5; this is a tiny shim so PR 2's tests can exercise
 * the SDK's storage-backed pieces (cursor store, echo suppression,
 * per-connection state core) without pulling in a heavier harness.
 */
import type { CursorStorageAdapter } from "./cursor-store.js";

export interface InMemoryStorage extends CursorStorageAdapter {
  list(options?: {
    prefix?: string;
    limit?: number;
  }): Promise<Map<string, unknown>>;
  /** Test-only — direct snapshot of the backing map. */
  _snapshot(): ReadonlyMap<string, unknown>;
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
    _snapshot(): ReadonlyMap<string, unknown> {
      return new Map(data);
    },
  };
}
