import type { Storage } from "../storage/interface.js";

export function runtimeCredentialItemSource(connectionId: string): string {
  return `integration:${connectionId}`;
}

/**
 * Serialize every credential mint and terminal lifecycle change for one
 * Connection. Postgres uses a blocking advisory lock across instances;
 * SQLite queues callers in process. The callback must re-read Connection
 * state after acquiring the lock rather than relying on an earlier check.
 */
export function withConnectionLifecycleLock<T>(
  storage: Storage,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.coordination.withExclusiveLock(
    `connection-lifecycle:${connectionId}`,
    fn,
  );
}
