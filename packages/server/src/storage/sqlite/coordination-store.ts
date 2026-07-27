import type { CoordinationStore } from "../interface.js";

/**
 * SQLite coordination — pass-through. The SQLite backend is always
 * single-process (better-sqlite3 + a file on disk), so there is no other
 * instance to coordinate with. `withJobLock` simply runs `fn`.
 */
export class SqliteCoordinationStore implements CoordinationStore {
  private readonly exclusiveTails = new Map<string, Promise<void>>();

  withJobLock<T>(_name: string, fn: () => Promise<T>): Promise<T | undefined> {
    return fn();
  }

  async withExclusiveLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveTails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.exclusiveTails.set(name, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.exclusiveTails.get(name) === tail) {
        this.exclusiveTails.delete(name);
      }
    }
  }
}
