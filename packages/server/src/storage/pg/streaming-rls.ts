import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { PgClient, PgDb } from "./connection.js";
import { pgRequestContext, type PgTxContext } from "./request-context.js";

/**
 * T-146: session-level RLS for streaming routes (`/events`, `/export`).
 *
 * The transaction-wrapping middleware (`rls-tenant-context.ts`) cannot
 * cover streaming responses — the stream holds the response open for an
 * arbitrary duration and a long-lived transaction would pin a pool
 * connection in the same scope, accumulate locks, and risk deadlocks.
 *
 * This helper achieves the same DB-level tenant fence via a different
 * mechanism: it reserves one pool connection for the stream, issues
 * **session-level** (not `SET LOCAL`) `SET ROLE myme_app` plus
 * `set_config('myme.tenant_id', '<id>', false)`, and pins the
 * connection in the request-context ALS so the existing storage proxy
 * routes every read through it. On stream end (normal completion,
 * error, client disconnect, server shutdown) the helper resets the
 * session state — `RESET ROLE` plus clearing the `myme.tenant_id`
 * GUC — and returns the connection to the pool. If the reset fails the
 * connection is destroyed instead so it never returns poisoned. The
 * scoped reset is the precise match for the cleanup invariant ("no
 * leaked tenant context on connection return to pool"); the previous
 * `DISCARD ALL` was a sledgehammer that also invalidated server-side
 * prepared statements while postgres.js retained their client-side
 * names, surfacing as `prepared statement "<name>" does not exist`
 * 500s on subsequent writes under concurrent SSE + write load (T-189).
 * RLS policies read `current_setting('myme.tenant_id')` at execute
 * time, not bind time, so cached statements are safe to survive the
 * reset.
 *
 * **Why session-level rather than per-event short transactions:**
 * per-event txs add latency per emit and complicate cursor / replay
 * semantics. Session-level config persists for the connection's
 * lifetime without holding a tx open. Pool isolation prevents
 * cross-tenant contamination.
 *
 * **Trade-off:** each active stream consumes one pool slot. Today's
 * pool size is 10 (`pg/connection.ts`) — bottleneck is real only at
 * 10+ concurrent streams per server instance. Watch in staging; if it
 * bites, partition into a dedicated streaming sub-pool.
 *
 * **Connection-cleanup invariant.** The cleanup function is exposed
 * separately from the setup so callers that drive their own stream
 * lifetimes (e.g. the SSE pump in `routes/events.ts`) can hook every
 * termination path — including async pumps that continue running
 * after the route handler returns. Cleanup is idempotent and safe to
 * call from multiple paths.
 */

/**
 * Reserved-connection RLS context. Returned by `acquireStreamRls`;
 * callers MUST eventually invoke `release()` exactly once via a path
 * that fires on every termination (success / error / client abort /
 * server shutdown). `release()` is idempotent.
 */
export interface StreamRlsContext {
  /** Drizzle instance bound to the reserved connection. Storage
   *  classes consume this transparently via the `pgRequestContext`
   *  ALS proxy — callers don't pass it around. */
  streamDb: PgDb;
  /** Run `fn` with `streamDb` installed in the request-context ALS so
   *  storage methods flow through the reserved connection. The ALS
   *  scope ends when `fn` resolves; subsequent storage calls (e.g.
   *  inside a deferred pump) need to be inside their own
   *  `withInstalledContext` invocation. */
  withInstalledContext: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Synchronous variant for generator-style flows. Use the async
   *  variant unless you specifically need sync. */
  withInstalledContextSync: <T>(fn: () => T) => T;
  /** Idempotent cleanup: resets the session role + tenant GUC and
   *  releases the connection to the pool, or destroys it if cleanup
   *  fails. Safe to call from multiple termination paths. */
  release: () => Promise<void>;
}

/**
 * Reserve a connection, set session-level RLS context, and return a
 * `StreamRlsContext` for the caller to drive. Throws if the pool is
 * exhausted or the SET statements fail; the caller is responsible for
 * surfacing the error.
 *
 * The reserved connection is held until `release()` is called. Callers
 * MUST guarantee `release()` runs on every termination path —
 * including async pumps that outlive the route handler.
 */
export async function acquireStreamRls(
  client: PgClient,
  tenantId: string,
): Promise<StreamRlsContext> {
  const reserved = await client.reserve();
  try {
    // Session-level (third arg `false` = not LOCAL). Persists for the
    // life of this reserved connection — including across any nested
    // transactions the storage layer opens internally.
    await reserved`SELECT set_config('myme.tenant_id', ${tenantId}, false)`;
    // Role name is hardcoded — direct DDL is safe; SET ROLE doesn't
    // accept parameters.
    await reserved.unsafe(`SET ROLE myme_app`);
  } catch (err) {
    // Setup failed — connection may be in an unknown state. Try to
    // discard and release; on cascade failure, destroy. The caller
    // sees the original error.
    await disposeReserved(reserved);
    throw err;
  }

  // Drizzle's postgres-js driver reads `client.options.parsers` /
  // `.serializers` once at construction (driver.js:18) — postgres-js's
  // `reserve()` returns a fresh `Sql(handler)` that doesn't propagate
  // `.options`. Patch it from the parent client so Drizzle can build
  // its session. Same options object → identical parser config.
  const reservedSql = reserved as unknown as PgClient;
  if (!(reservedSql as { options?: unknown }).options) {
    Object.defineProperty(reservedSql, "options", {
      value: (client as unknown as { options: unknown }).options,
      configurable: true,
      writable: false,
      enumerable: false,
    });
  }
  // Drizzle over the reserved connection. Same Sql surface for query
  // methods; the reserved instance pins every query to one pool
  // connection (postgres-js's reserve semantics).
  const streamDb = drizzle(reservedSql, {
    schema,
  }) as unknown as PgDb;

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await disposeReserved(reserved);
  };

  const withInstalledContext = async <T>(fn: () => Promise<T>): Promise<T> =>
    pgRequestContext.run({ tx: streamDb as unknown as PgTxContext }, fn);

  const withInstalledContextSync = <T>(fn: () => T): T =>
    pgRequestContext.run({ tx: streamDb as unknown as PgTxContext }, fn);

  return {
    streamDb,
    withInstalledContext,
    withInstalledContextSync,
    release,
  };
}

/**
 * Run `fn` with full session-level RLS lifecycle, ALS installation,
 * and guaranteed cleanup. The cleanest path for routes whose entire
 * work happens inside a single async function (e.g. `/export`); /events
 * uses `acquireStreamRls` directly because its pumps outlive the route
 * handler.
 */
export async function withStreamRls<T>(
  client: PgClient,
  tenantId: string,
  fn: (streamDb: PgDb) => Promise<T>,
): Promise<T> {
  const ctx = await acquireStreamRls(client, tenantId);
  try {
    return await ctx.withInstalledContext(() => fn(ctx.streamDb));
  } finally {
    await ctx.release();
  }
}

/**
 * Reset session state and release. If reset fails (broken connection,
 * unexpected error), destroy the connection so it never returns to
 * the pool carrying the tenant role + setting — a leaked connection
 * would be served to a future request and read another tenant's
 * rows. Catastrophic. The cost of destroy is one re-establishment;
 * the cost of a leak is unbounded.
 *
 * Scoped reset, not `DISCARD ALL`. The cleanup invariant is "no
 * leaked tenant context on connection return to pool" — that's
 * narrower than `DISCARD ALL`, which also drops every prepared
 * statement on the session. postgres.js caches statement names
 * client-side per `Sql` instance and reuses them across reservations
 * of the same underlying connection; nuking the server side without
 * a client-side invalidation hook surfaces as `prepared statement
 * "<name>" does not exist` 500s on the next request that touches the
 * recycled connection (T-189 — ~20% POST /items failure rate under
 * concurrent SSE + writes). The two statements below clear exactly
 * what was set in `acquireStreamRls`:
 *
 *   - `RESET ROLE` — back to the pool's default owner role.
 *   - `SELECT set_config('myme.tenant_id', '', false)` — empty the
 *     custom GUC. Plain `RESET myme.tenant_id` would also work but
 *     `set_config` matches the form used at acquire time and avoids
 *     surprising error semantics if the GUC was never set on this
 *     connection (idempotent on either path).
 *
 * RLS policies read `current_setting('myme.tenant_id')` at execute
 * time, not bind time, so any prepared statement compiled while the
 * session carried tenant A's GUC executes safely under tenant B once
 * the GUC flips — the cache is value-agnostic.
 *
 * Must run outside a transaction; streaming routes don't wrap their
 * cleanup in one.
 */
async function disposeReserved(
  reserved: Awaited<ReturnType<PgClient["reserve"]>>,
): Promise<void> {
  try {
    await reserved.unsafe(`RESET ROLE`);
    await reserved`SELECT set_config('myme.tenant_id', '', false)`;
  } catch (err) {
    // Reset failed — connection is in an unknown state. Destroy
    // rather than return-to-pool. Log loud: silent connection
    // destruction is hard to operate; an operator seeing this once
    // is fine, repeatedly is a real signal (Postgres connectivity
    // issue, or worse, a state-leak path we haven't anticipated).
    console.warn(
      "[streaming-rls] session reset failed; destroying reserved connection",
      err,
    );
    try {
      await reserved.end();
    } catch {
      // Already disconnected. Nothing more to do.
    }
    return;
  }
  // Cleaned successfully — return to the pool.
  reserved.release();
}
