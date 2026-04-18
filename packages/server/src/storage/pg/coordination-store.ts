import type { CoordinationStore } from "../interface.js";
import type { PgClient } from "./connection.js";

/**
 * Postgres-backed job coordination via session-scoped advisory locks.
 *
 * Multi-instance deployments run the same background jobs (trash purge,
 * version thinning, audit cleanup, webhook poller) on every server. Without
 * a cross-instance gate each instance does the same idempotent work on
 * every tick — wasted cycles. The gate is `pg_try_advisory_lock` keyed by a
 * bigint hash of the job name. Exactly one instance acquires per tick; the
 * others see `acquired = false` and skip the tick cleanly.
 *
 * Session-scoped (not transaction-scoped) because the caller's `fn` may
 * open its own transactions. A dedicated connection is reserved for the
 * lock's lifetime so the acquire / release pair runs on the same session.
 */
export class PgCoordinationStore implements CoordinationStore {
  constructor(private client: PgClient) {}

  async withJobLock<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const key = `myme:${name}`;
    const conn = await this.client.reserve();
    try {
      const rows = await conn<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS acquired
      `;
      const acquired = rows[0]?.acquired === true;
      if (!acquired) return undefined;
      try {
        return await fn();
      } finally {
        await conn`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
      }
    } finally {
      conn.release();
    }
  }
}
