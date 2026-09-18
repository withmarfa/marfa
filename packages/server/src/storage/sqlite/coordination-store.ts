import type { CoordinationStore } from "../interface.js";

/**
 * SQLite coordination — pass-through. The SQLite backend is always
 * single-process (better-sqlite3 + a file on disk), so there is no other
 * instance to coordinate with. `withJobLock` simply runs `fn`.
 */
export class SqliteCoordinationStore implements CoordinationStore {
  private readonly exclusiveTails = new Map<string, Promise<void>>();

  // The options parameter on the interface is a reservation budget; there
  // is nothing to reserve here.
  withJobLock<T>(_name: string, fn: () => Promise<T>): Promise<T | undefined> {
    return fn();
  }

  withLongLivedJobLock<T>(
    _name: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    return fn();
  }

  /**
   * No-op. `runInTransaction` opens `BEGIN IMMEDIATE`, which takes SQLite's
   * single write lock for the whole transaction, so writers in one process
   * are already serialised and there is no second process to exclude.
   */
  lockInTransaction(): Promise<void> {
    return Promise.resolve();
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
