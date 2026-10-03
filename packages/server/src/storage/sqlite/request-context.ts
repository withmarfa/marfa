import {
  createRegistryFrame,
  mergeRegistryFrame,
  discardRegistryFrame,
  type RegistryFrame,
  type RegistryReadScope,
} from "@withmarfa/shared";
import {
  registryContext,
  rootRegistryParticipant,
  assertRegistryReady,
} from "./registry-context.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ReadLifetime } from "./read-lifetime.js";
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
 * Better Auth uses this same handle, so captured provider adapters and
 * its nested transactions enlist in the current writer.
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

export interface SqliteReadScope extends RegistryReadScope {
  tx: DrizzleDb;
  lifetime: ReadLifetime;
  pin: Readonly<{ instanceId: string; structuralGeneration: string }>;
}
interface SqliteWriteScope {
  mode: "write";
  tx: SqliteTxContext;
}
type SqliteRequestContext = SqliteWriteScope | SqliteReadScope;

export const sqliteRequestContext =
  new AsyncLocalStorage<SqliteRequestContext>();

/**
 * Wrap a Drizzle libsql instance so per-request transactions transparently
 * substitute. Storage classes and the private credential adapter consume
 * this wrapped instance.
 */
export function wrapDbWithRequestContext(baseDb: DrizzleDb): DrizzleDb {
  return new Proxy(baseDb, {
    get(target, prop, receiver) {
      const ctx = sqliteRequestContext.getStore();
      if (ctx?.mode === "read") ctx.assertActive();
      // `tx` and `baseDb` differ in TS surface but are runtime-compatible
      // for the storage-layer surface area. The cast lets the proxy's
      // `get` trap forward through either uniformly.
      const source: object = ctx?.tx ?? target;

      if (
        ctx?.mode === "read" &&
        ["transaction", "insert", "update", "delete"].includes(String(prop))
      )
        return () => {
          ctx.assertActive();
          throw new Error("A read snapshot cannot write or nest transactions");
        };

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
            if (parentFrame?.mode === "read")
              throw new Error(
                "A read snapshot cannot nest a writer transaction",
              );
            if (parentFrame && (!parentFrame.active || parentFrame.sealed))
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
                    sqliteRequestContext.run(
                      { mode: "write", tx: newTx },
                      async () => {
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
                      },
                    ),
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
                    root.outcome === "rolled_back" ? "rolled_back" : "unknown",
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
        return (...args: unknown[]) => {
          if (ctx?.mode === "read") ctx.assertActive();
          const invoke = () =>
            (value as (...args: unknown[]) => unknown).apply(source, args);
          return ctx?.mode === "read"
            ? runWithReadContext(ctx, invoke)
            : invoke();
        };
      }
      return value;
    },
  });
}

function runWithReadContext<T>(scope: SqliteReadScope, fn: () => T): T {
  scope.assertActive();
  // Retained methods may be dispatched by another async context while this
  // scope is open. Both SQL and registry selection must follow the capability.
  return registryContext.run(scope, () => sqliteRequestContext.run(scope, fn));
}

export function guardStoreWithReadContext<T extends object>(store: T): T {
  const methods = new WeakMap<
    (...args: unknown[]) => unknown,
    (...args: unknown[]) => unknown
  >();
  return new Proxy(store, {
    get(target, prop) {
      const captured = sqliteRequestContext.getStore();
      if (captured?.mode === "read") captured.assertActive();
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (captured?.mode !== "read") {
        const existing = methods.get(method);
        if (existing) return existing;
      }
      const wrapped = new Proxy(method, {
        apply(fn, _thisArg, args) {
          const scope =
            captured?.mode === "read"
              ? captured
              : sqliteRequestContext.getStore();
          if (scope?.mode === "read") scope.assertActive();
          const invoke = () => Reflect.apply(fn, target, args);
          const result: unknown =
            scope?.mode === "read"
              ? runWithReadContext(scope, invoke)
              : invoke();
          if (scope?.mode === "read" && result instanceof Promise)
            return result.then((value: unknown) => {
              scope.assertActive();
              return value;
            });
          return result;
        },
      });
      if (captured?.mode !== "read") methods.set(method, wrapped);
      return wrapped;
    },
  });
}
