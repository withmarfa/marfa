/**
 * Opaque cursor read/write API. Backed by per-Connection DO storage
 * in production; backed by an in-memory Map in tests.
 *
 * The cursor is a single JSON value per (connection, trigger). The
 * runtime doesn't introspect it — integrations own the shape (an ETag,
 * a timestamp, a page token, …). The SDK keeps the surface
 * generic-free; callers cast to their integration-specific shape at
 * the call site, which keeps the storage interface simple.
 */
export interface CursorStore {
  /** Returns the cursor for the given trigger key. `null` when no
   *  cursor has been written yet (first run of a freshly installed
   *  Connection). Cast to the integration's cursor type at the call
   *  site. */
  read(triggerKey: string): Promise<unknown>;

  /** Atomically replaces the cursor. */
  write(triggerKey: string, value: unknown): Promise<void>;

  /** Deletes the cursor; subsequent reads return null. */
  clear(triggerKey: string): Promise<void>;
}

/** Storage interface the cursor store reads/writes against. Both the
 *  Cloudflare DO storage and the in-memory test storage satisfy this
 *  shape (subset of `DurableObjectStorage`). */
export interface CursorStorageAdapter {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

const CURSOR_PREFIX = "cursor:";

export function createCursorStore(storage: CursorStorageAdapter): CursorStore {
  return {
    async read(triggerKey: string): Promise<unknown> {
      const v = await storage.get(`${CURSOR_PREFIX}${triggerKey}`);
      return v ?? null;
    },
    async write(triggerKey: string, value: unknown): Promise<void> {
      await storage.put(`${CURSOR_PREFIX}${triggerKey}`, value);
    },
    async clear(triggerKey: string): Promise<void> {
      await storage.delete(`${CURSOR_PREFIX}${triggerKey}`);
    },
  };
}
