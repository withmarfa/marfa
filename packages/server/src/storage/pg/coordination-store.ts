import { sql } from "drizzle-orm";
import type { CoordinationStore } from "../interface.js";
import type { PgClient, PgDb } from "./connection.js";
import { reserveWithTimeout } from "./reserve-timeout.js";
import { log } from "../../middleware/logger.js";

/**
 * How long a job tick waits for a session-pool slot before skipping.
 * `reserveWithTimeout` spends it across two asks rather than one, so this
 * is the whole budget and not a per-attempt one.
 *
 * The pool is shared with streams, so exhaustion is a real state, and a
 * background tick queued behind it indefinitely is worse than a missed
 * tick: every caller of `withJobLock` already treats `undefined` as
 * "not this time". Generous on purpose, because a loaded machine can hold
 * every slot for whole seconds at a time and a tick that skips on an
 * ordinary spike trades a real run for nothing. Request-path callers pass
 * their own tighter budget per call.
 */
const JOB_LOCK_RESERVE_TIMEOUT_MS = 15_000;

/**
 * How long the process-lifetime holder waits for its own connection.
 *
 * Comfortably under the election's own retry cadence, so a lost
 * reservation costs one round rather than stalling the loop, and
 * comfortably above anything a single-connection client should take to
 * answer when it is genuinely free.
 */
const HOLDER_RESERVE_TIMEOUT_MS = 5_000;

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
   * lifetime never subtracts a slot from the pool streams and job ticks
   * share; the drainer once quietly took a fifth of it.
   *
   * **Bounded, because an unbounded wait here parks the election.** This
   * used to reserve with no timeout, on the reasoning that nothing else
   * reserves from that client so a wait could only mean this process was
   * already holding it. `reserve-timeout.ts` records the other way a
   * reservation waits forever: it can be destroyed by any connection
   * close, never resolving and never rejecting. That client carries the
   * same idle timeout as the shared pool and the election retries on the
   * same period, so a loser meets the race on exactly the cadence that
   * produces it, and the caller is an unconditional loop with no timer of
   * its own. It would have stopped re-electing, silently, and a winner's
   * death would have left no takeover: the failure the retry loop exists
   * to prevent.
   *
   * `undefined` here means the same thing it means for a lost election, so
   * a caller needs nothing new: it retries on its own cadence and says so.
   */
  async withLongLivedJobLock<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const key = `marfa:${name}`;
    const { connection, waitedMs, attempts } = await reserveWithTimeout(
      this.jobHolderClient,
      HOLDER_RESERVE_TIMEOUT_MS,
    );
    if (connection === null) {
      // Said out loud, because the caller cannot. An election loop reads
      // `undefined` as a lost election and reports it as one, so without
      // this line a holder that never reserves looks identical to a holder
      // that keeps losing, and the difference is whether anyone is running
      // the job at all.
      log("warn", "long-lived job lock skipped: no connection reserved", {
        job: name,
        waited_ms: waitedMs,
        attempts,
        budget_ms: HOLDER_RESERVE_TIMEOUT_MS,
      });
      return undefined;
    }
    return this.runUnderTryLock(connection, key, fn);
  }

  private async tryLockOn<T>(
    client: PgClient,
    name: string,
    fn: () => Promise<T>,
    reserveTimeoutMs?: number,
  ): Promise<T | undefined> {
    const key = `marfa:${name}`;
    const timeoutMs = reserveTimeoutMs ?? this.reserveTimeoutMs;
    const { connection, waitedMs, attempts } = await reserveWithTimeout(
      client,
      timeoutMs,
    );
    if (connection === null) {
      // The message says what was measured and stops there. It used to
      // name a cause, "session pool exhausted", that nothing here
      // establishes: two asks can both be lost to closes against a pool
      // with free slots, so neither exhaustion nor the race can be read
      // off this branch. A skipped tick retries on its own timer; the
      // proxy-refresh caller falls back to its in-process single-flight.
      log("warn", "job lock skipped: no connection reserved", {
        job: name,
        waited_ms: waitedMs,
        attempts,
        budget_ms: timeoutMs,
      });
      return undefined;
    }
    if (attempts > 1) {
      // The recovery, which the skip line cannot carry: without it the
      // only symptom of a lost first ask is a tick running late.
      //
      // The branch means the probe expired, not that the reservation was
      // destroyed. `waited_ms` leans one way or the other rather than
      // settling it: a wait barely over the probe fits the race in
      // `reserve-timeout.ts`, and it fits a pool that freed a slot just
      // after the probe gave up equally well.
      log("info", "job lock reserved on the second ask", {
        job: name,
        waited_ms: waitedMs,
      });
    }
    return this.runUnderTryLock(connection, key, fn);
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
