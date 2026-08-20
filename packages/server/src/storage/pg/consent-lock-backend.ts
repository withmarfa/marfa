/**
 * Cross-process consent lock over a session-scoped Postgres advisory
 * lock, plugged into `withConsentLock` via `setConsentLockBackend`.
 *
 * A BLOCKING lock, deliberately: `CoordinationStore`'s try-lock answers
 * "someone else has it, skip this tick", which suits a background job and
 * not a user-facing consent request that has to complete. The session
 * shape (rather than the transaction-scoped shape the coordination store
 * uses) is safe here for the same reason streaming RLS can hold session
 * state: a reserved connection owns a real backend for its whole life.
 * The critical section spans network work (the consent flow proxies into
 * the auth plugin), which is also why the lock cannot ride a transaction:
 * a database transaction held open across a network round trip is the
 * worse trade.
 *
 * The client this reserves from must be DEDICATED to this backend, never
 * a pool the critical section's own queries run on. The section queries
 * the app pool (grant reads, the Better Auth proxy), so reserving its
 * lock connection from that same pool means enough concurrent consent
 * flows hold every slot while each waits for a slot nobody can release —
 * the documented bracketing deadlock, reached at pool size rather than at
 * load. index.ts constructs the small dedicated client.
 *
 * Reservation is bounded (`reserveWithTimeout`): exhaustion answers a
 * clean 503-shaped refusal rather than queueing callers forever.
 *
 * Cleanup destroys the connection on ANY doubt rather than returning it
 * to the pool. `pg_advisory_lock` is re-entrant per session, so a pooled
 * connection that still holds the lock hands instant, silent acquisition
 * to the next caller that lands on it — exclusion fails open, and the
 * once-stranded hold then wedges the key for the life of the process.
 * Three doubts qualify: the acquire threw (the lock may have landed
 * server-side before the failure), the unlock threw, or the unlock
 * returned false (the session did not hold the lock it should have).
 */
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { PgClient } from "./connection.js";
import { reserveWithTimeout } from "./reserve-timeout.js";
import type { ConsentLockBackend } from "../../auth/consent-lock.js";

const RESERVE_TIMEOUT_MS = 5_000;

export interface PgConsentLockBackendOptions {
  /** Test hook: production keeps the 5s default. */
  reserveTimeoutMs?: number;
}

export function createPgConsentLockBackend(
  dedicatedClient: PgClient,
  options?: PgConsentLockBackendOptions,
): ConsentLockBackend {
  const reserveTimeoutMs = options?.reserveTimeoutMs ?? RESERVE_TIMEOUT_MS;
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const advisoryKey = `marfa:consent:${key}`;
    const reserved = await reserveWithTimeout(
      dedicatedClient,
      reserveTimeoutMs,
    );
    if (reserved === null) {
      throw new MarfaError(
        ErrorCode.CONSENT_CAPACITY_EXHAUSTED,
        "Too many permission changes are in flight right now; retry shortly",
      );
    }
    let mustDestroy = false;
    try {
      try {
        // session-scoped-by-design: the reservation above owns one real
        // backend for the whole hold (dedicated session-mode client, per
        // the module doc), and the critical section spans network I/O
        // that a transaction-scoped lock would force into a held-open
        // transaction.
        await reserved`SELECT pg_advisory_lock(hashtextextended(${advisoryKey}, 0))`;
      } catch (err) {
        mustDestroy = true;
        throw err;
      }
      try {
        return await fn();
      } finally {
        try {
          const rows =
            await reserved`SELECT pg_advisory_unlock(hashtextextended(${advisoryKey}, 0)) AS released`; // session-scoped-by-design: pairs with the acquire above
          if (rows[0]?.released !== true) mustDestroy = true;
        } catch {
          mustDestroy = true;
        }
      }
    } finally {
      if (mustDestroy) {
        try {
          await reserved.end();
        } catch {
          // Destroying an already-broken connection can itself fail; the
          // pool has forgotten the reservation either way.
        }
      } else {
        reserved.release();
      }
    }
  };
}
