/**
 * Cross-process consent lock over a session-scoped Postgres advisory
 * lock, plugged into `withConsentLock` via `setConsentLockBackend`.
 *
 * A BLOCKING lock, deliberately: `CoordinationStore`'s try-lock answers
 * "someone else has it, skip this tick", which suits a background job and
 * not a user-facing consent request that has to complete. The session
 * shape (rather than the transaction-scoped shape the coordination store
 * uses) is safe here for the same reason streaming RLS can hold session
 * state: this backend reserves from the session-mode client, where a
 * reserved connection owns a real backend for its whole life. It must
 * never be handed the pooled client of a transaction-mode deployment.
 *
 * The critical section spans network work (the consent flow proxies into
 * the auth plugin), so the reservation is held across I/O. That is the
 * documented trade the module doc in auth/consent-lock.ts anticipates:
 * consent flows are rare, short, and bounded by request timeouts, and
 * the alternative is the silent revoked-permission resurrection this
 * exists to close.
 *
 * Cleanup mirrors streaming-rls.ts: unlock, then release; if the unlock
 * fails the connection is destroyed rather than returned holding a lock
 * a future reservation would inherit.
 */
import type { PgClient } from "./connection.js";
import type { ConsentLockBackend } from "../../auth/consent-lock.js";

export function createPgConsentLockBackend(
  sessionClient: PgClient,
): ConsentLockBackend {
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const hashedKey = `marfa:consent:${key}`;
    const reserved = await sessionClient.reserve();
    let destroyed = false;
    try {
      await reserved`SELECT pg_advisory_lock(hashtextextended(${hashedKey}, 0))`;
      try {
        return await fn();
      } finally {
        try {
          await reserved`SELECT pg_advisory_unlock(hashtextextended(${hashedKey}, 0))`;
        } catch {
          // A connection whose unlock failed is in an unknown state and
          // still holds the lock; destroying it releases the lock with
          // the session instead of returning it to the pool still held.
          destroyed = true;
          await reserved.end();
        }
      }
    } finally {
      if (!destroyed) reserved.release();
    }
  };
}
