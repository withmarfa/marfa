import { AsyncLocalStorage } from "node:async_hooks";
import type { PgDb } from "./connection.js";

/**
 * Per-request DB substitution for Postgres RLS.
 *
 * The RLS pattern requires every storage operation issued during a request
 * to flow through ONE connection — the same connection that carries
 * `SET LOCAL ROLE marfa_app` and `SET LOCAL marfa.tenant_id = '<id>'`.
 * Drizzle's `db.transaction()` returns a transaction object (`tx`) that
 * meets that contract: every query issued through `tx` uses the
 * transaction's reserved connection. The challenge is threading `tx` to
 * every store method without changing every signature in the storage layer.
 *
 * This module provides two primitives:
 *
 * 1. `pgRequestContext` — an AsyncLocalStorage holding the active
 *    transaction object for the current request. Set by the RLS
 *    middleware (`rls-tenant-context.ts`); read by the proxy below.
 * 2. `wrapDbWithRequestContext(baseDb)` — a Proxy around the base
 *    Drizzle instance that consults the ALS first. Every method call
 *    (`select`, `insert`, `update`, `delete`, `execute`,
 *    `transaction`, etc.) is forwarded to either the active
 *    transaction (when one is present) or the base instance (the
 *    fallback for non-request code paths and for requests where RLS
 *    enforcement is disabled).
 *
 * Storage classes hold a reference to the wrapped instance and
 * continue to call `this.db.select(...)` etc. unchanged. The
 * substitution is transparent.
 *
 * **Why a Proxy, not a getter on every store?** Drizzle's instance
 * surface is large (every table-builder, every relational helper) and
 * mostly used via property access (`db.select`, `db.transaction`).
 * A Proxy intercepts at the access site rather than requiring every
 * store to be rewritten with `getDb()` calls. Two-line change at the
 * connection layer; zero change at every store.
 *
 * **Better-auth bypass.** The Better Auth instance is constructed
 * with the *unwrapped* base db (`storage.betterAuthDb`). Auth runs
 * its own context-management (cookies, sessions) outside the request
 * middleware that sets the ALS, so it always operates as the
 * connection owner. Better Auth tables (`auth_*`) have no RLS
 * policies; this is correct.
 *
 * **Non-HTTP code paths.** Retention jobs, the webhook poller, and
 * server boot all run without a request context. Their queries fall
 * through the proxy to the base db (no ALS context → no transaction
 * substitution) and execute as the connection owner. Correct: these
 * paths intentionally see all tenants.
 */

/**
 * Type of the Drizzle transaction object passed to a `db.transaction`
 * callback. Extracted from the PgDb signature so this stays correct
 * if Drizzle's typings shift. At runtime this is broadly compatible
 * with `PgDb` for the surface storage classes use (`select`,
 * `insert`, `update`, `delete`, `execute`, `transaction`).
 */
export type PgTxContext = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

interface PgRequestContext {
  /**
   * Active Drizzle transaction object for this request. Stores
   * issuing queries through the wrapped db will hit this transaction
   * — and therefore the reserved connection carrying `SET LOCAL
   * ROLE marfa_app` and `SET LOCAL marfa.tenant_id = '<id>'`.
   */
  tx: PgTxContext;
}

export const pgRequestContext = new AsyncLocalStorage<PgRequestContext>();

/**
 * Wrap a Drizzle PG instance so per-request transactions transparently
 * substitute. Storage classes consume this wrapped instance; the
 * unwrapped base instance is reserved for Better Auth and other
 * code paths that intentionally bypass the per-request context.
 */
export function wrapDbWithRequestContext(baseDb: PgDb): PgDb {
  // The proxy target is the base db itself — non-method access
  // (e.g. `db._.session` for internals) falls through correctly,
  // and method access is redirected via the `get` trap below.
  return new Proxy(baseDb, {
    get(target, prop) {
      const ctx = pgRequestContext.getStore();
      // `tx` and `baseDb` differ in TS surface (PgTransaction vs
      // PostgresJsDatabase) but are runtime-compatible for the
      // storage-layer surface area; the cast lets the proxy's
      // `get` trap forward through either uniformly.
      const source: object = ctx?.tx ?? target;
      // Methods on Drizzle's db are typically returned bound to the
      // instance (the query builder retains internal state). Reflect
      // already returns them bound to `source` here; nothing further
      // to do. Reflect.get is typed as `any`, so route through
      // `unknown` explicitly to keep the proxy's `get` trap clean
      // for lint without changing the runtime semantics.
      const value: unknown = Reflect.get(source, prop, source) as unknown;
      return value;
    },
  });
}
