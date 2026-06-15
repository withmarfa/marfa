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
 *
 * **By-value semantics on put + get.** Real Cloudflare DO storage
 * serializes every value to bytes on `put` and deserializes on `get` —
 * there is no shared reference between the caller's input and the
 * stored value, and no shared reference between two successive `get`s
 * of the same key. The in-memory adapter mirrors that contract via
 * `structuredClone` on both ends. Without this, handlers that mutate a
 * cursor object in-place leak the mutation back into the stored map (and
 * into every subsequent reader), which works in tests but breaks the
 * moment the handler hits real DO storage.
 *
 * `structuredClone` is the natural primitive because it matches what
 * DO storage uses internally and handles every shape the runtime-sdk
 * persists today (cursors, idempotency rings, echo bloom filters)
 * without ad-hoc JSON-roundtrip caveats.
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
