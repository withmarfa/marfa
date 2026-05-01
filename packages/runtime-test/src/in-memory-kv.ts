/**
 * In-memory KV namespace shim. Implements the methods the control
 * plane uses (get, put with expirationTtl, delete) — not the full
 * KVNamespace surface.
 *
 * Expiration is honored: a key with `expirationTtl` set is purged on
 * the next `get` if its expiry has elapsed. Tests can pass a custom
 * `now()` to deterministically advance expiry.
 */
export interface InMemoryKV {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  /** Test-only — direct snapshot. */
  snapshot(): ReadonlyMap<string, { value: string; expires_at: number | null }>;
}

export function createInMemoryKV(now: () => number = Date.now): InMemoryKV {
  const data = new Map<string, { value: string; expires_at: number | null }>();
  return {
    get(key: string): Promise<string | null> {
      const entry = data.get(key);
      if (!entry) return Promise.resolve(null);
      if (entry.expires_at !== null && entry.expires_at <= now()) {
        data.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.value);
    },
    put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> {
      const expires_at =
        opts?.expirationTtl !== undefined
          ? now() + opts.expirationTtl * 1000
          : null;
      data.set(key, { value, expires_at });
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      data.delete(key);
      return Promise.resolve();
    },
    snapshot(): ReadonlyMap<
      string,
      { value: string; expires_at: number | null }
    > {
      return new Map(data);
    },
  };
}
