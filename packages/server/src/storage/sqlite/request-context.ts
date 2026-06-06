import { AsyncLocalStorage } from "node:async_hooks";
import type { DrizzleDb } from "./connection.js";

/**
 * Per-request DB substitution for SQLite transactions.
 *
 * The libsql driver supports genuine async transactions, but only when
 * queries are issued through the transaction object Drizzle hands to the
 * `db.transaction(async (tx) => ...)` callback. Queries issued through
 * the outer `db` while a transaction is in flight land on a different
 * connection that doesn't see the in-flight writes (and hits SQLITE_BUSY
 * on writes because the tx connection holds the writer lock). The
 * challenge is threading `tx` to every store method without changing
 * every signature in the storage layer.
 *
 * This module mirrors the PG version (`storage/pg/request-context.ts`):
 *
 * 1. `sqliteRequestContext` — an AsyncLocalStorage holding the active
 *    transaction object. Set by the `.transaction(...)` interception
 *    below; read by the proxy on every method access.
 * 2. `wrapDbWithRequestContext(baseDb)` — a Proxy around the base
 *    Drizzle instance that consults the ALS first. Method access
 *    (`select`, `insert`, `update`, `delete`, `run`, `execute`)
 *    is forwarded to either the active tx (when one is present) or the
 *    base instance (the fallback for non-tx code paths like reads,
 *    retention sweeps, and boot).
 *
 *    The proxy also intercepts `.transaction(callback)` itself: it
 *    wraps the callback so the new transaction is installed on the
 *    ALS for the duration of the inner work. This makes nested
 *    transactions and store-internal `db.transaction(...)` calls (e.g.
 *    `item-store.create` opening its own write tx) thread the active
 *    tx into every downstream store call automatically. Without this,
 *    inner store calls would access the outer client and hit
 *    SQLITE_BUSY against the writer lock the tx is holding.
 *
 * Storage classes hold a reference to the wrapped instance and continue
 * to call `this.db.select(...)` etc. unchanged. The substitution is
 * transparent.
 *
 * **Better-auth bypass.** The Better Auth instance is constructed with
 * the *unwrapped* base db (`storage.betterAuthDb`). Auth runs its own
 * context-management (cookies, sessions) outside the request middleware
 * and would be confused by a substituted db.
 *
 * **Non-HTTP code paths.** Retention jobs, the webhook poller, and
 * server boot all run without an ALS context. Their queries fall
 * through the proxy to the base db (no ALS context → no transaction
 * substitution) and execute non-transactionally. Correct: these paths
 * are intentionally non-transactional.
 */

/**
 * Type of the Drizzle transaction object passed to a `db.transaction`
 * callback. Extracted from the DrizzleDb signature so this stays correct
 * if Drizzle's typings shift. At runtime this is broadly compatible with
 * `DrizzleDb` for the surface storage classes use.
 */
export type SqliteTxContext = Parameters<
  Parameters<DrizzleDb["transaction"]>[0]
>[0];

interface SqliteRequestContext {
  /**
   * Active Drizzle transaction object for this request. Stores issuing
   * queries through the wrapped db will hit this transaction — and
   * therefore the reserved connection holding the libsql `BEGIN
   * IMMEDIATE` writer lock.
   */
  tx: SqliteTxContext;
}

export const sqliteRequestContext =
  new AsyncLocalStorage<SqliteRequestContext>();

/**
 * Run `fn` with `tx` installed on the per-request ALS, so every store
 * call inside `fn` resolves its executor to the transaction.
 *
 * Used directly by the storage's top-level `runInTransaction`. For
 * store-internal `db.transaction(...)` calls, the proxy below wraps the
 * callback automatically — no need to call this helper there.
 */
export function withSqliteTx<T>(
  tx: SqliteTxContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return Promise.resolve(sqliteRequestContext.run({ tx }, () => fn()));
}

/**
 * Wrap a Drizzle libsql instance so per-request transactions transparently
 * substitute. Storage classes consume this wrapped instance; the unwrapped
 * base instance is reserved for Better Auth and other code paths that
 * intentionally bypass the per-request context.
 */
export function wrapDbWithRequestContext(baseDb: DrizzleDb): DrizzleDb {
  return new Proxy(baseDb, {
    get(target, prop, receiver) {
      const ctx = sqliteRequestContext.getStore();
      // `tx` and `baseDb` differ in TS surface but are runtime-compatible
      // for the storage-layer surface area. The cast lets the proxy's
      // `get` trap forward through either uniformly.
      const source: object = ctx?.tx ?? target;

      if (prop === "transaction") {
        // Intercept .transaction(callback) so the new tx is installed on
        // the ALS for the duration of the callback. This makes every
        // downstream store call inside the tx flow through the held
        // writer connection — without this, calls on the proxy would
        // see no ALS, fall through to the base client, and hit
        // SQLITE_BUSY.
        const original = Reflect.get(source, prop, source) as unknown;
        if (typeof original !== "function") return original;
        const fn = original as (...args: unknown[]) => unknown;
        const bound: (...args: unknown[]) => unknown = fn.bind(source);
        return (
          callback: (tx: SqliteTxContext) => unknown,
          ...rest: unknown[]
        ) => {
          return bound(
            (newTx: SqliteTxContext) =>
              sqliteRequestContext.run({ tx: newTx }, () => callback(newTx)),
            ...rest,
          );
        };
      }

      const value: unknown = Reflect.get(source, prop, receiver) as unknown;
      // Bind methods to the source so `this` is the tx (or base db) — not
      // the Proxy. Drizzle's query builders return chained objects whose
      // internal references would otherwise dangle.
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(source);
      }
      return value;
    },
  });
}
