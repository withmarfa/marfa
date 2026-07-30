import { sql } from "drizzle-orm";
import type { CoordinationStore } from "../interface.js";
import type { PgClient, PgDb } from "./connection.js";

/**
 * Postgres-backed coordination via advisory locks.
 *
 * Two shapes, for two jobs.
 *
 * `withJobLock` is the cross-instance gate on background work. Multi-instance
 * deployments run the same jobs (trash purge, version thinning, audit
 * cleanup, webhook poller) on every server; without a gate each instance does
 * the same idempotent work on every tick. `pg_try_advisory_lock` keyed by a
 * bigint hash of the job name gives exactly one instance the tick; the others
 * see `acquired = false` and skip cleanly.
 *
 * `withExclusiveLock` is the blocking gate on a critical section that has to
 * happen once — the Connection lifecycle lock that serializes a runtime
 * credential mint against an uninstall.
 *
 * **A session-scoped lock needs a session, and a pooled endpoint is not one.**
 * The pair that reads correctly — reserve a connection, `pg_advisory_lock`,
 * run, `pg_advisory_unlock` — assumes the reserved link owns a backend for
 * its whole life. Behind a transaction-mode pooler it does not: PgBouncer
 * assigns a server connection per transaction, and a bare statement is its
 * own transaction, so the acquire lands on whichever backend was free and
 * the matching release need not reach it. Measured against PgBouncer 1.25 in
 * `pool_mode = transaction`, two callers hold one lock at once and a lock
 * outlives the client that took it. That is the same class as the
 * session-level `SET ROLE` that made streaming RLS need a direct endpoint.
 *
 * `withExclusiveLock` therefore takes a **transaction**-scoped lock inside an
 * explicit transaction. A transaction is the unit a pooler keeps on one
 * backend, so acquire and release are the same backend by construction, and
 * release happens on commit, rollback or disconnect rather than depending on
 * a statement arriving somewhere. Slot cost is unchanged: the previous shape
 * already held a reserved connection for the whole of `fn`.
 *
 * `fn` runs outside that transaction, on whatever connection the storage
 * layer would normally use. It is deliberately not wrapped: the lock's job is
 * to exclude other lock-takers, not to make `fn` atomic, and the callers
 * (`connections/lifecycle-lock.ts`) open their own transactions.
 *
 * `withJobLock` is deliberately left session-scoped. Its `fn` is a background
 * job that can run for minutes, and an explicit transaction held that long
 * is a worse trade than the failure it would fix: the failure is a second
 * instance repeating idempotent work, and it cannot hang anything because a
 * try-lock never waits.
 */
export class PgCoordinationStore implements CoordinationStore {
  constructor(
    private client: PgClient,
    private db: PgDb,
  ) {}

  /**
   * `pg_advisory_xact_lock` on the transaction the caller is already inside,
   * so it costs no second pool slot and releases on that transaction's commit
   * or rollback. Issued through the request-context-aware Drizzle instance,
   * which is what puts it on the ambient transaction's connection rather than
   * an arbitrary one — the same routing `runInTransaction` and the search
   * indexer rely on. Called outside a transaction it degrades to a
   * statement-scoped lock that releases immediately, which is why the
   * interface makes the requirement explicit rather than trying to detect it.
   */
  async lockInTransaction(name: string): Promise<void> {
    const key = `marfa:${name}`;
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  withExclusiveLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const key = `marfa:${name}`;
    return this.client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      return fn();
    }) as Promise<T>;
  }

  async withJobLock<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const key = `marfa:${name}`;
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
