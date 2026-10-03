import {
  createRegistryFrame,
  mergeRegistryFrame,
  discardRegistryFrame,
  type RegistryFrame,
} from "@withmarfa/shared";
import {
  registryContext,
  rootRegistryParticipant,
  assertRegistryReady,
} from "./registry-context.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DrizzleDb } from "./connection.js";
import {
  TransactionControl,
  transactionControl,
} from "./transaction-control.js";

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
 * Two parts:
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
 * Without a wrapped transaction scope, queries use the base database.
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
  tx: SqliteTxContext;
}

export const sqliteRequestContext =
  new AsyncLocalStorage<SqliteRequestContext>();

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
        const original = Reflect.get(source, prop, source) as unknown;
        if (typeof original !== "function") return original;
        const fn = original as (...args: unknown[]) => unknown;
        const bound: (...args: unknown[]) => unknown = fn.bind(source);
        return (
          callback: (tx: SqliteTxContext) => unknown,
          ...rest: unknown[]
        ) => {
          const root =
            transactionControl.getStore() ?? new TransactionControl();
          return transactionControl.run(root, async () => {
            root.assertUsable();
            assertRegistryReady();
            const parentFrame = registryContext.getStore();
            if (parentFrame && !parentFrame.active)
              throw new Error("Registry transaction context is closed");
            let frame: RegistryFrame | undefined;
            const previousCause = root.callbackCause;
            const callbackState: { failed: boolean; error?: unknown } = {
              failed: false,
            };
            try {
              const result = await bound(
                (newTx: SqliteTxContext) => {
                  if (parentFrame) frame = createRegistryFrame(parentFrame);
                  else {
                    const structural = rootRegistryParticipant();
                    frame = structural.frame;
                    root.participant = structural.participant;
                  }
                  return registryContext.run(frame, () =>
                    sqliteRequestContext.run({ tx: newTx }, async () => {
                      try {
                        const result = await callback(newTx);
                        root.assertUsable();
                        return result;
                      } catch (error) {
                        callbackState.failed = true;
                        callbackState.error = error;
                        root.callbackCause = error;
                        throw error;
                      }
                    }),
                  );
                },
                ...rest,
              );
              if (frame?.parent) mergeRegistryFrame(frame);
              return result;
            } catch (error) {
              if (!root.begun && !ctx) throw error;
              if (!callbackState.failed || error !== callbackState.error) {
                if (!root.error())
                  root.invalidate(
                    callbackState.failed ? callbackState.error : error,
                    "poisoned",
                    "unknown",
                  );
                if (callbackState.failed) root.diagnose(error);
              }
              root.assertUsable();
              throw error;
            } finally {
              if (frame?.active) discardRegistryFrame(frame);
              root.callbackCause = previousCause;
            }
          });
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
