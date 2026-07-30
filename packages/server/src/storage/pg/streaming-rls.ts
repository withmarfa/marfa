import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { PgClient, PgDb } from "./connection.js";
import { pgRequestContext, type PgTxContext } from "./request-context.js";

/**
 * Session-level RLS for streaming routes (`/events`, `/export`).
 *
 * The transaction-wrapping middleware (`rls-space-context.ts`) cannot
 * cover streaming responses — the stream holds the response open for an
 * arbitrary duration and a long-lived transaction would pin a pool
 * connection in the same scope, accumulate locks, and risk deadlocks.
 *
 * This helper achieves the same DB-level space fence via a different
 * mechanism: it reserves one pool connection for the stream, issues
 * **session-level** (not `SET LOCAL`) `SET ROLE marfa_app` plus
 * `set_config('marfa.space_id', '<id>', false)`, and pins the
 * connection in the request-context ALS so the existing storage proxy
 * routes every read through it. On stream end (normal completion,
 * error, client disconnect, server shutdown) the helper resets the
 * session state — `RESET ROLE` plus clearing the `marfa.space_id`
 * GUC — and returns the connection to the pool. If the reset fails the
 * connection is destroyed instead so it never returns poisoned. The
 * scoped reset is the precise match for the cleanup invariant ("no
 * leaked space context on connection return to pool"); using
 * `DISCARD ALL` also invalidated server-side prepared statements while
 * postgres.js retained their client-side names, surfacing as
 * `prepared statement "<name>" does not exist` 500s on subsequent
 * writes under concurrent SSE + write load. RLS policies read
 * `current_setting('marfa.space_id')` at execute time, not bind time,
 * so cached statements are safe to survive the reset.
 *
 * **Why session-level rather than per-event short transactions:**
 * per-event txs add latency per emit and complicate cursor / replay
 * semantics. Session-level config persists for the connection's
 * lifetime without holding a tx open.
 *
 * **Connection requirement — must be a direct/session-mode endpoint.**
 * Session-level `SET ROLE` is only self-contained when the reserved
 * connection maps 1:1 to a real backend for its whole lifetime. Over a
 * transaction-mode pooler (Neon's pooled endpoint, the app's
 * `DATABASE_URL`) PgBouncer multiplexes backends per statement, so a
 * session-level role can strand on a shared backend and be inherited by a
 * later, unrelated write — this is exactly how hosted sign-up's owner write
 * began running as `marfa_app` and hitting RLS. Callers therefore pass the
 * dedicated direct/session-mode client (`storage.pgStreamClient`, configured
 * via `MARFA_DATABASE_URL_DIRECT`; see `connection.ts`). On a direct
 * connection the reserve → SET ROLE → reset-or-destroy cycle below is
 * genuinely isolated and nothing leaks onto the app pool. There is NO pool
 * isolation when this runs on a transaction-mode pooled client.
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
  /** Idempotent cleanup: resets the session role + space GUC and
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
  spaceId: string,
): Promise<StreamRlsContext> {
  const reserved = await client.reserve();
  try {
    // Session-level (`false` = not LOCAL) — persists for the reserved
    // connection's lifetime, including across nested storage transactions.
    await reserved`SELECT set_config('marfa.space_id', ${spaceId}, false)`;
    // SET ROLE doesn't accept parameters; hardcoded role name is safe.
    await reserved.unsafe(`SET ROLE marfa_app`);
  } catch (err) {
    await disposeReserved(reserved);
    throw err;
  }

  // postgres-js `reserve()` returns a fresh `Sql(handler)` without `.options`.
  // Patch it from the parent client so Drizzle gets the same parser config.
  const reservedSql = reserved as unknown as PgClient;
  if (!(reservedSql as { options?: unknown }).options) {
    Object.defineProperty(reservedSql, "options", {
      value: (client as unknown as { options: unknown }).options,
      configurable: true,
      writable: false,
      enumerable: false,
    });
  }
  const streamDb = drizzle(reservedSql, {
    schema,
  });

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
  spaceId: string,
  fn: (streamDb: PgDb) => Promise<T>,
): Promise<T> {
  const ctx = await acquireStreamRls(client, spaceId);
  try {
    return await ctx.withInstalledContext(() => fn(ctx.streamDb));
  } finally {
    await ctx.release();
  }
}

/**
 * Scoped reset + release. On failure, destroy the connection rather than
 * returning it to the pool with leaked space context. See module-level
 * doc for the DISCARD ALL / prepared-statement rationale.
 */
async function disposeReserved(
  reserved: Awaited<ReturnType<PgClient["reserve"]>>,
): Promise<void> {
  try {
    await reserved.unsafe(`RESET ROLE`);
    await reserved`SELECT set_config('marfa.space_id', '', false)`;
  } catch (err) {
    // Reset failed — destroy rather than return a poisoned connection.
    // Repeated warnings here are a real signal (connectivity issue or
    // an unanticipated state-leak path).
    console.warn(
      "[streaming-rls] session reset failed; destroying reserved connection",
      err,
    );
    try {
      await reserved.end();
    } catch {
      // Already disconnected.
    }
    return;
  }
  reserved.release();
}
