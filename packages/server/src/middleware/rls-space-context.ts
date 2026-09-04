import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { pgRequestContext } from "../storage/pg/request-context.js";
import type { PgDb } from "../storage/pg/connection.js";
import type { AppEnv } from "./auth.js";

/**
 * Postgres RLS request-level enforcement.
 *
 * Wraps each space-bounded request in a transaction with `SET LOCAL
 * ROLE marfa_app` and `set_config('marfa.space_id', $space, true)`,
 * then runs the downstream handler with that transaction stored on
 * `pgRequestContext` (AsyncLocalStorage). The Drizzle proxy
 * (`request-context.ts:wrapDbWithRequestContext`) consults the ALS
 * on every storage operation, so all queries flow through the
 * reserved connection that carries the role + space_id and are
 * therefore subject to the per-table RLS policies.
 *
 * **Mount AFTER auth + cycle, BEFORE routes.** The middleware reads
 * `c.var.apiKey?.space_id`. Auth must have populated the api key
 * before this gate runs.
 *
 * **Three cases:**
 *
 *   1. **RLS disabled** (`config.rlsEnforce === false`; the flag
 *      defaults to enabled, so this is the explicit opt-out).
 *      Pass-through. No transaction wrapper. All queries flow on the
 *      base owner connection with no SET LOCAL — single-space
 *      self-hosts and the existing application-layer scoping
 *      continue unchanged.
 *
 *   2. **RLS enabled, no space on the api key.** Includes
 *      anonymous/public routes (no api key), platform-admin keys
 *      (`space_id IS NULL`), and bootstrap. These are platform-tier
 *      contexts that intentionally see all spaces — they bypass the
 *      role switch and run on the owner connection. Application-
 *      layer audit + the platform-admin-only gate
 *      (`requireAdmin`) are still load-bearing here.
 *
 *   3. **RLS enabled, request has a space.** Wrap the handler in
 *      `db.transaction(...)` and set `SET LOCAL ROLE marfa_app` +
 *      `marfa.space_id`. Storage queries during the request flow
 *      through the transaction's reserved connection. RLS policies
 *      filter every read/write to the session space.
 *
 * **Streaming-response exemption.** SSE streams (`/events`) and the
 * archive export (`/export`) hold the response open for an arbitrary
 * duration — wrapping them in a transaction would hold a pool
 * connection open for the same duration. They're exempted by URL
 * pattern HERE, but they are NOT bypass paths for RLS overall: the
 * streaming routes apply session-level (`SET`, not `SET LOCAL`)
 * `marfa.space_id` + `SET ROLE marfa_app` on a dedicated pool
 * connection inside the route itself (see
 * `storage/pg/streaming-rls.ts`). The exemption keeps the long-lived
 * transaction model away from streams; it does not skip the DB-level
 * fence.
 *
 * **`SET LOCAL` correctness.** `set_config(name, value, true)` is
 * the parameterized form of `SET LOCAL` — safe under postgres-js
 * binding, and `role` is an ordinary GUC, so setting it this way IS
 * `SET LOCAL ROLE` with identical privilege checks. Both settings are
 * scoped to the surrounding transaction by definition; on COMMIT or
 * ROLLBACK the connection returns to the pool with them cleared.
 */

interface RlsMiddlewareOptions {
  rlsEnforce: boolean;
  /**
   * The Drizzle PG instance — wrapped (per-request proxy) on top of
   * the base owner connection. Storage classes already hold this
   * same instance; we receive a separate reference so the middleware
   * can drive `db.transaction(...)` directly.
   */
  db: PgDb | null;
}

/**
 * URL-prefix exemption list for streaming responses. See
 * "Streaming-response exemption" in the file-level docstring.
 *
 * Match is prefix-based against the request path: a leading-slash
 * URL beginning with any string in this list bypasses the RLS
 * wrapper. Using prefixes (rather than exact matches) catches
 * `/events`, `/events/*` (any future subroutes), `/export`,
 * `/export/blobs`, etc. uniformly.
 */
const STREAMING_PATH_PREFIXES = ["/events", "/export"] as const;

function isStreamingPath(path: string): boolean {
  return STREAMING_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix + "/"),
  );
}

/**
 * Run `fn` inside a short transaction carrying the space's RLS context.
 *
 * The middleware below is the usual caller, wrapping a whole request. It
 * is exported because `/events` is exempt from that wrapper and still has
 * one bounded read to make before its body starts streaming — the
 * event-log head it announces. That read is request-shaped rather than
 * stream-shaped: one scalar, once, on the ordinary pool, released
 * immediately. It deliberately does NOT go through
 * `storage/pg/streaming-rls.ts`, which reserves from a five-connection
 * pool for the length of a read; putting a per-connect reservation there
 * would make a fresh viewer contend with every replaying one, and answer
 * 503 to a client that has nothing to catch up on.
 */
export async function withRlsSpaceTransaction<T>(
  db: PgDb,
  spaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('marfa.space_id', ${spaceId}, true), set_config('role', 'marfa_app', true)`,
    );
    return pgRequestContext.run({ tx }, fn);
  });
}

export function rlsSpaceContextMiddleware(options: RlsMiddlewareOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { rlsEnforce, db } = options;

    // Case 1: RLS disabled or PG not configured (SQLite dialect).
    if (!rlsEnforce || db === null) {
      await next();
      return;
    }

    // Case 2: no space on the request — platform admin / anonymous /
    // bootstrap. Bypass the role switch.
    const spaceId = c.var.apiKey?.space_id;
    if (!spaceId) {
      await next();
      return;
    }

    // Streaming-response exemption.
    if (isStreamingPath(c.req.path)) {
      await next();
      return;
    }

    // Case 3: space-bounded — wrap downstream in a transaction with
    // SET LOCAL ROLE marfa_app + space_id. Both settings ride one
    // statement: set_config('role', …, true) IS `SET LOCAL ROLE` (the
    // role is an ordinary GUC), and nothing reads a result between the
    // two, so issuing them separately was one round trip of pure
    // latency on every space-bounded request.
    await withRlsSpaceTransaction(db, spaceId, async () => {
      await next();
    });
  });
}
