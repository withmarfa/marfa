import { sql } from "drizzle-orm";
import type { CoordinationStore } from "../interface.js";
import type { PgClient, PgDb } from "./connection.js";
import { reserveWithTimeout } from "./reserve-timeout.js";
import { log } from "../../middleware/logger.js";

/**
 * How long a job tick waits for a session-pool slot before skipping.
 * The pool is shared with streams, so exhaustion is a real state, and a
 * background tick queued behind it indefinitely is worse than a missed
 * tick: every caller of `withJobLock` already treats `undefined` as
 * "not this time". Generous on purpose — a loaded machine can hold every
 * slot for whole seconds at a time, and a background tick that skips on
 * an ordinary spike trades a real run for nothing. Request-path callers
 * pass their own tighter budget per call.
 */
const JOB_LOCK_RESERVE_TIMEOUT_MS = 15_000;

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
 * `withJobLock` stays session-scoped, because its `fn` is a background job that
 * can run for minutes and an explicit transaction held that long is a worse
 * trade. What it cannot do is take that lock on the pooled client. The
 * consolation above — "the failure is a second instance repeating idempotent
 * work" — assumes the holder is a live instance doing the work. Over the
 * pooler it need not be: a lock outlives the client that took it, so the
 * holder can be a backend whose process is long gone, and then nobody runs the
 * job at all.
 *
 * That is survivable for a job that retries on a timer, which is what most
 * callers are: a lost tick costs one tick. It is not survivable for a job
 * elected once and held for the process lifetime, which is what the
 * reactive-run bridge's drainer is. There the orphan wins the election
 * forever, the drainer never starts, and the only symptom is that nothing
 * happens.
 *
 * So the try-lock runs on `sessionClient`, the direct session-mode endpoint
 * that streaming RLS already needs for the same reason. A reserved connection
 * there owns a backend for its whole life, which is the assumption the
 * session-scoped shape was always making and only gets on that endpoint.
 */
export class PgCoordinationStore implements CoordinationStore {
  /**
   * `sessionClient` defaults to `client` for the direct-Postgres case, where
   * they are the same pool and the distinction does not arise.
   */
  constructor(
    private client: PgClient,
    private db: PgDb,
    private sessionClient: PgClient = client,
    private jobHolderClient: PgClient = sessionClient,
    private reserveTimeoutMs: number = JOB_LOCK_RESERVE_TIMEOUT_MS,
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
    options?: { reserveTimeoutMs?: number },
  ): Promise<T | undefined> {
    return this.tryLockOn(
      this.sessionClient,
      name,
      fn,
      options?.reserveTimeoutMs,
    );
  }

  /**
   * The permanent holder's variant. Reserves from the dedicated
   * single-connection client, so the one lock held for the process
   * lifetime never subtracts a slot from the pool streams and job
   * ticks share — the drainer once quietly took a fifth of it. No
   * reservation timeout: nothing else reserves from that client, so a
   * wait here means the same process is already holding it, which the
   * try-lock below answers honestly.
   */
  async withLongLivedJobLock<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const key = `marfa:${name}`;
    const conn = await this.jobHolderClient.reserve();
    return this.runUnderTryLock(conn, key, fn);
  }

  private async tryLockOn<T>(
    client: PgClient,
    name: string,
    fn: () => Promise<T>,
    reserveTimeoutMs?: number,
  ): Promise<T | undefined> {
    const key = `marfa:${name}`;
    const timeoutMs = reserveTimeoutMs ?? this.reserveTimeoutMs;
    const conn = await reserveWithTimeout(client, timeoutMs);
    if (conn === null) {
      // The pool is exhausted — most plausibly by concurrent streams.
      // A skipped tick retries on its own timer; the proxy-refresh
      // caller falls back to its in-process single-flight. Waiting in
      // the queue instead would add this caller to the pileup.
      log("warn", "job lock skipped: session pool exhausted", {
        job: name,
        waited_ms: timeoutMs,
      });
      return undefined;
    }
    return this.runUnderTryLock(conn, key, fn);
  }

  private async runUnderTryLock<T>(
    conn: Awaited<ReturnType<PgClient["reserve"]>>,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      // session-scoped-by-design: a try-lock that never waits, held on a
      // reserved connection for a background job that can run for minutes.
      // Reserved from the session-mode client so the backend it lands on is
      // the one the matching unlock reaches.
      const rows = await conn<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS acquired
      `;
      const acquired = rows[0]?.acquired === true;
      if (!acquired) return undefined;
      try {
        return await fn();
      } finally {
        // session-scoped-by-design: releases the try-lock above.
        await conn`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
      }
    } finally {
      conn.release();
    }
  }
}
