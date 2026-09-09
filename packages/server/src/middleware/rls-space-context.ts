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
 *      base owner connection with no SET LOCAL — instance-wide
 *      self-hosts and the existing application-layer scoping
 *      continue unchanged.
 *
 *   2. **RLS enabled, no space on the api key.** Includes
 *      anonymous/public routes (no api key), the operator key
 *      (`space_id IS NULL`), and bootstrap. These are space-less
 *      contexts that intentionally see all spaces — they bypass the
 *      role switch and run on the owner connection. Application-
 *      layer audit + the operator gate (`requireOperatorKey`) are
 *      still load-bearing here.
 *
 *   3. **RLS enabled, request has a space.** Wrap the handler in
 *      `db.transaction(...)` and set `SET LOCAL ROLE marfa_app` +
 *      `marfa.space_id`. Storage queries during the request flow
 *      through the transaction's reserved connection. RLS policies
 *      filter every read/write to the session space.
 *
 * **Transaction-wrapper exemptions.** A handler whose lifetime is not
 * the lifetime of the work it does at the database would hold a pooled
 * connection for time the database has no interest in. Two shapes
 * qualify, and both are exempted by URL HERE:
 *
 *   - **Streaming responses.** SSE streams (`/events`) and the archive
 *     export (`/export`) hold the response open for an arbitrary
 *     duration.
 *   - **Handlers that block on an upstream call.**
 *     `/connections/:id/proxy/*` awaits a third party mid-handler, so
 *     the wrapper spends a connection on somebody else's latency. Three
 *     concurrent proxied calls against a pool of three are the whole web
 *     tier.
 *
 * **Neither is a bypass path for RLS**, and the fences differ. The
 * streaming routes apply session-level (`SET`, not `SET LOCAL`)
 * `marfa.space_id` + `SET ROLE marfa_app` on a dedicated pool
 * connection inside the route itself (see
 * `storage/pg/streaming-rls.ts`). The proxy route runs every database
 * access through `createRlsFence` below, which is this middleware's own
 * decision applied per phase rather than per request. An exempt route
 * that reads or writes outside its fence runs as the connection owner
 * and sees every space, so the exemption and the fence ship together or
 * not at all.
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
 * "Transaction-wrapper exemptions" in the file-level docstring.
 *
 * Match is prefix-based against the request path: a leading-slash
 * URL beginning with any string in this list bypasses the RLS
 * wrapper. Using prefixes (rather than exact matches) catches
 * `/events`, `/events/*` (any future subroutes), `/export`,
 * `/export/blobs`, etc. uniformly.
 */
const STREAMING_PATH_PREFIXES = ["/events", "/export"] as const;

/**
 * Exemption patterns for handlers that block on an outbound call they do
 * not control. See "Transaction-wrapper exemptions" above.
 *
 * A pattern list rather than a second prefix list, because the segment
 * that varies is in the middle of the path: the connection id sits
 * between `/connections/` and `/proxy`, and a prefix match anchored at
 * the start of the path cannot express that. Matching `/connections/`
 * alone would exempt every connection route, most of which never leave
 * the process.
 *
 * The trailing group keeps the match on the proxy route itself rather
 * than on any sibling that merely starts with those characters.
 */
const UPSTREAM_CALL_PATH_PATTERNS = [
  /^\/connections\/[^/]+\/proxy(?:\/|$)/,
] as const;

function isTransactionWrapperExempt(path: string): boolean {
  return (
    STREAMING_PATH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(prefix + "/"),
    ) || UPSTREAM_CALL_PATH_PATTERNS.some((pattern) => pattern.test(path))
  );
}

/**
 * Run `fn` inside a short transaction carrying the space's RLS context.
 *
 * The middleware below is the usual caller, wrapping a whole request. It
 * is exported for the routes that middleware exempts and that still have
 * database work to fence: `/events` reads the event-log head it announces
 * before its body starts streaming, and `/connections/:id/proxy/*` fences
 * each of its phases through `createRlsFence` below.
 *
 * Both are request-shaped rather than stream-shaped: bounded work on the
 * ordinary pool, released immediately. `/events` deliberately does NOT
 * go through `storage/pg/streaming-rls.ts`, which reserves from a
 * five-connection pool for the length of a read; putting a per-connect
 * reservation there would make a fresh viewer contend with every
 * replaying one, and answer 503 to a client that has nothing to catch up
 * on.
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

/**
 * The per-phase form of the wrapper below, for routes exempted from it.
 *
 * Returns a function that runs one database phase under the same fence
 * the middleware would have installed for the whole request, and makes
 * the same three-way decision on the same inputs — so an exempt route
 * fences exactly when a wrapped one would, and is a pass-through exactly
 * when a wrapped one would be. Keeping the decision here rather than
 * restating it at the call site is the point: a route that copied the
 * condition could drift from it, and the way it would drift is by
 * fencing less.
 *
 * **Identity is not a weaker fence, it is the absence of one, and both
 * cases that produce it are already unfenced today.** With
 * `rlsEnforce` off or on SQLite there are no policies to enforce, and a
 * request with no space on its key is the operator tier, which reads
 * across spaces by design.
 *
 * A phase is as much work as can be done without waiting on anything
 * outside the database. The caller's obligation is the whole of the
 * contract: **every** access goes through this, and no fence encloses an
 * upstream call or a lock whose holder needs a connection of its own.
 */
export type RlsFence = <T>(fn: () => Promise<T>) => Promise<T>;

export function createRlsFence(
  db: PgDb | null,
  rlsEnforce: boolean,
  spaceId: string | undefined,
): RlsFence {
  if (!rlsEnforce || db === null || spaceId === undefined || spaceId === "") {
    return (fn) => fn();
  }
  return (fn) => withRlsSpaceTransaction(db, spaceId, fn);
}

export function rlsSpaceContextMiddleware(options: RlsMiddlewareOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { rlsEnforce, db } = options;

    // Case 1: RLS disabled or PG not configured (SQLite dialect).
    if (!rlsEnforce || db === null) {
      await next();
      return;
    }

    // Case 2: no space on the request — the operator key / anonymous /
    // bootstrap. Bypass the role switch.
    const spaceId = c.var.apiKey?.space_id;
    if (!spaceId) {
      await next();
      return;
    }

    // Transaction-wrapper exemption. The route fences its own database
    // work — see the file-level docstring.
    if (isTransactionWrapperExempt(c.req.path)) {
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
