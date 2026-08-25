/**
 * In-memory `CursorStorageAdapter` for this package's own unit tests.
 *
 * **Why a second one exists.** `@withmarfa/runtime-test` ships the fake
 * integration authors use, and this package cannot depend on it: that
 * package depends on this one, so the edge would close a cycle in the
 * workspace graph — the class of cycle `build-order.test.ts` exists
 * because it broke a container build once. So the kit keeps its own, and
 * that is a dependency-direction constraint rather than a preference.
 *
 * **By-value semantics, matching the shipped fake and the production
 * store.** The production store serializes on write and parses on read, so
 * there is no shared reference between the caller's input and the stored
 * value, nor between two successive reads of one key. This one used to
 * store and hand back the caller's reference, which meant the kit's own
 * cursor store, echo suppression and queue consumer were exercised against
 * semantics that differed from production *and* from the fake the same
 * repository ships for the purpose. A handler mutating a cursor in place
 * passed here and would have leaked into the stored map against the real
 * store.
 *
 * It is deliberately not on this package's root: authors should reach for
 * `@withmarfa/runtime-test`, and the reachability check records that as an
 * exclusion with this reason rather than treating it as an oversight.
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
      const v = data.get(key);
      // No shared reference out, matching the production store.
      return Promise.resolve(v === undefined ? undefined : structuredClone(v));
    },
    put(key: string, value: unknown): Promise<void> {
      // Capture the shape at write time, so a later in-place mutation of
      // the caller's object does not reach back into the stored value.
      data.set(key, structuredClone(value));
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
    _snapshot(): ReadonlyMap<string, unknown> {
      return new Map(structuredClone([...data]));
    },
  };
}
