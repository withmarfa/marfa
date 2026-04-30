/**
 * Token storage interface and default implementations.
 *
 * Browser default: localStorage keyed by `(origin, client_id)`.
 * Node default: in-memory; Node consumers can pass a file-backed
 * implementation if they need cross-process persistence.
 */

export interface TokenStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryTokenStorage implements TokenStorage {
  private map = new Map<string, string>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export class LocalStorageTokenStorage implements TokenStorage {
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(key: string): Promise<string | null> {
    return globalThis.localStorage.getItem(key);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async set(key: string, value: string): Promise<void> {
    globalThis.localStorage.setItem(key, value);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<void> {
    globalThis.localStorage.removeItem(key);
  }
}

/** Pick the most appropriate default storage for the current runtime. */
export function defaultTokenStorage(): TokenStorage {
  if (typeof globalThis.localStorage !== "undefined") {
    return new LocalStorageTokenStorage();
  }
  return new InMemoryTokenStorage();
}
