import type { IntegrationManifest } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

/**
 * Provenance keys on the integration and the space rather than the
 * Connection, so uninstall-then-reinstall lands on the items already
 * there: the natural-key pair (source, source_id) survives the
 * Connection id changing. Space scoping needs no encoding here — every
 * item row carries space_id and the natural-key lookup is space-bounded.
 *
 * A credential minted without a resolvable manifest gets no provenance
 * identity at all: it holds no type grants and can write no integration
 * items, and inventing a connection-keyed source for it would quietly
 * resurrect the corpus-forking shape this keying exists to end.
 */
export function runtimeCredentialItemSource(
  manifest: Pick<IntegrationManifest, "name"> | null | undefined,
): string | null {
  return manifest ? `integration:${manifest.name}` : null;
}

/**
 * The advisory key both lock shapes below take. They exclude each other
 * because the key is the same: one lock, two ways of holding it.
 */
function lifecycleLockName(connectionId: string): string {
  return `connection-lifecycle:${connectionId}`;
}

/**
 * Serialize a terminal lifecycle change for one Connection — install,
 * uninstall, pause, resume. Postgres uses a blocking advisory lock across
 * instances; SQLite queues callers in process. The callback must re-read
 * Connection state after acquiring the lock rather than relying on an
 * earlier check.
 *
 * This shape brackets `fn` from a transaction of its own, so `fn` is free
 * to do network I/O and to open transactions of its own. Uninstall, pause
 * and upgrade all run multi-step pipelines while holding the lock, and a
 * database transaction held open across a whole pipeline is the worse
 * trade. Mints take {@link withConnectionLifecycleLockInTransaction}
 * instead: they are pure database work and they run on every dispatch.
 *
 * The connection that holds the lock comes from a pool of its own, and
 * that is load-bearing rather than incidental. `fn` queries the app pool,
 * so a lock held from the app pool deadlocks it at its own size, with no
 * contention for the lock required. The bound lives with the pool, in
 * `storage/pg/connection.ts`.
 */
export function withConnectionLifecycleLock<T>(
  storage: Storage,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.coordination.withExclusiveLock(
    lifecycleLockName(connectionId),
    fn,
  );
}

/**
 * The same exclusion for callers whose work is pure database work: the
 * lock rides the transaction `fn` runs in rather than bracketing it from
 * a connection of its own.
 *
 * **Why the mint paths need this and the lifecycle paths do not.** A lock
 * that opens its own pool connection needs a second slot for the work
 * inside it, so concurrent callers each hold one slot while waiting for a
 * slot nobody can release. Pool size, not load, sets the concurrency at
 * which that stops: ten simultaneous mints exhaust a ten-slot pool, and
 * they do it whether or not they contend for the lock, because the slot
 * is taken before the key is ever compared. Minting runs on every
 * dispatch of every integration, so it reaches that ceiling in ordinary
 * traffic — it did, and the server stopped answering.
 *
 * Riding the caller's transaction costs one slot total, releases on
 * commit or rollback rather than at the end of the callback, and makes
 * the mint atomic as a side effect: a credential and the retirement of
 * the siblings it supersedes now land together or not at all.
 *
 * Exclusion against the lifecycle paths is unaffected. Both shapes take
 * `pg_advisory_xact_lock` on the same key, so an uninstall still blocks a
 * mint and a mint still blocks an uninstall.
 *
 * `fn` must not do network I/O: it runs inside an open transaction.
 */
export function withConnectionLifecycleLockInTransaction<T>(
  storage: Storage,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // SQLite takes the bracketing form, and must. There is no connection
  // pool to exhaust — its coordination store queues callers in process —
  // so the shape this function exists to avoid costs nothing there. More
  // importantly the substitute would be wrong: `lockInTransaction` is a
  // documented no-op on SQLite, where exclusion comes from `BEGIN
  // IMMEDIATE` taking the single write lock. That excludes other writers
  // but not a holder of the in-process mutex, so a mint would stop
  // serializing against an uninstall already in flight.
  if (!storage.pgDb) {
    return withConnectionLifecycleLock(storage, connectionId, fn);
  }

  return storage.runInTransaction(async () => {
    await storage.coordination.lockInTransaction(
      lifecycleLockName(connectionId),
    );
    return fn();
  });
}
