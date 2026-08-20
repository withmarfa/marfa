/**
 * In-memory implementation of the storage-adapter subset the runtime
 * SDK uses. Sufficient for the cursor store, the echo-suppression
 * helper, and the queue consumer's `storageFor()` callback.
 *
 * This is the test-time replacement for the server's per-Connection
 * runtime storage (the `connection.runtime` extension namespace). The
 * keying + values match that schema exactly so a handler tested
 * against this storage behaves identically in production.
 *
 * **By-value semantics on put + get.** The production store serializes
 * every value on write and parses on read — there is no shared
 * reference between the caller's input and the stored value, and no
 * shared reference between two successive `get`s of the same key. The
 * in-memory adapter mirrors that contract via `structuredClone` on
 * both ends. Without this, handlers that mutate a cursor object
 * in-place leak the mutation back into the stored map (and into every
 * subsequent reader), which works in tests but breaks against the real
 * store.
 *
 * `structuredClone` handles every shape the runtime-sdk persists today
 * (cursors, idempotency rings, echo-suppression records) without
 * ad-hoc JSON-roundtrip caveats.
 */
import type { CursorStorageAdapter } from "@withmarfa/runtime-sdk";

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
      const v = data.get(key);
      return Promise.resolve(v === undefined ? undefined : structuredClone(v)); // DO parity: no shared refs
    },
    put(key: string, value: unknown): Promise<void> {
      data.set(key, structuredClone(value)); // capture shape at write time
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
        if (k.startsWith(prefix)) out.set(k, structuredClone(v));
      }
      return Promise.resolve(out);
    },
    snapshot(): ReadonlyMap<string, unknown> {
      // Deep clone so test-side mutation of the snapshot can't bleed into storage.
      const out = new Map<string, unknown>();
      for (const [k, v] of data) out.set(k, structuredClone(v));
      return out;
    },
    reset(): void {
      data.clear();
    },
  };
}
