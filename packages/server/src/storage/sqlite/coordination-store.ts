import type { CoordinationStore } from "../interface.js";

/**
 * SQLite coordination — pass-through. The SQLite backend is always
 * single-process (better-sqlite3 + a file on disk), so there is no other
 * instance to coordinate with. `withJobLock` simply runs `fn`.
 */
export class SqliteCoordinationStore implements CoordinationStore {
  withJobLock<T>(_name: string, fn: () => Promise<T>): Promise<T | undefined> {
    return fn();
  }
}
