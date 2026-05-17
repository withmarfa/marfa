import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { pgRequestContext } from "../storage/pg/request-context.js";
import type { PgDb } from "../storage/pg/connection.js";
import type { AppEnv } from "./auth.js";

/**
 * T-025 part 2: Postgres RLS request-level enforcement.
 *
 * Wraps each tenant-bounded request in a transaction with `SET LOCAL
 * ROLE myme_app` and `set_config('myme.tenant_id', $tenant, true)`,
 * then runs the downstream handler with that transaction stored on
 * `pgRequestContext` (AsyncLocalStorage). The Drizzle proxy
 * (`request-context.ts:wrapDbWithRequestContext`) consults the ALS
 * on every storage operation, so all queries flow through the
 * reserved connection that carries the role + tenant_id and are
 * therefore subject to the per-table RLS policies (T-025 part 1).
 *
 * **Mount AFTER auth + cycle, BEFORE routes.** The middleware reads
 * `c.var.apiKey?.tenant_id`. Auth must have populated the api key
 * before this gate runs.
 *
 * **Three cases:**
 *
 *   1. **RLS disabled** (`config.rlsEnforce === false`, the default).
 *      Pass-through. No transaction wrapper. All queries flow on the
 *      base owner connection with no SET LOCAL — single-tenant
 *      self-hosts and the existing application-layer scoping
 *      continue unchanged.
 *
 *   2. **RLS enabled, no tenant on the api key.** Includes
 *      anonymous/public routes (no api key), platform-admin keys
 *      (`tenant_id IS NULL`), and bootstrap. These are platform-tier
 *      contexts that intentionally see all tenants — they bypass the
 *      role switch and run on the owner connection. Application-
 *      layer audit + the platform-admin-only gate
 *      (`requireAdmin`) are still load-bearing here.
 *
 *   3. **RLS enabled, request has a tenant.** Wrap the handler in
 *      `db.transaction(...)` and set `SET LOCAL ROLE myme_app` +
 *      `myme.tenant_id`. Storage queries during the request flow
 *      through the transaction's reserved connection. RLS policies
 *      filter every read/write to the session tenant.
 *
 * **Streaming-response exemption.** SSE streams (`/events`) and the
 * archive export (`/export`) hold the response open for an arbitrary
 * duration — wrapping them in a transaction would hold a pool
 * connection open for the same duration. They're exempted by URL
 * pattern HERE, but they are NOT bypass paths for RLS overall: T-146
 * closes the gap by applying session-level (`SET`, not `SET LOCAL`)
 * `myme.tenant_id` + `SET ROLE myme_app` on a dedicated pool
 * connection inside the route itself (see
 * `storage/pg/streaming-rls.ts`). The exemption keeps the long-lived
 * transaction model away from streams; it does not skip the DB-level
 * fence.
 *
 * **`SET LOCAL` correctness.** `set_config(name, value, true)` is
 * the parameterised form of `SET LOCAL` — safe under
 * postgres-js binding. `SET LOCAL ROLE myme_app` is hardcoded
 * (role name is not user-controlled), so direct DDL is safe. Both
 * are scoped to the surrounding transaction by definition; on
 * COMMIT or ROLLBACK the connection returns to the pool with the
 * settings cleared.
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

export function rlsTenantContextMiddleware(options: RlsMiddlewareOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { rlsEnforce, db } = options;

    // Case 1: RLS disabled or PG not configured (SQLite dialect).
    if (!rlsEnforce || db === null) {
      await next();
      return;
    }

    // Case 2: no tenant on the request — platform admin / anonymous /
    // bootstrap. Bypass the role switch.
    const tenantId = c.var.apiKey?.tenant_id;
    if (!tenantId) {
      await next();
      return;
    }

    // Streaming-response exemption.
    if (isStreamingPath(c.req.path)) {
      await next();
      return;
    }

    // Case 3: tenant-bounded — wrap downstream in a transaction with
    // SET LOCAL ROLE myme_app + tenant_id.
    await db.transaction(async (tx) => {
      // `set_config` is the parameterised form of `SET LOCAL` and is
      // therefore postgres-js-binding safe. The third arg `true`
      // makes it transaction-local (cleared at COMMIT/ROLLBACK).
      await tx.execute(
        sql`SELECT set_config('myme.tenant_id', ${tenantId}, true)`,
      );
      // Role name is hardcoded (not user-controlled) — direct DDL is
      // safe; SET LOCAL ROLE doesn't accept parameters.
      await tx.execute(sql`SET LOCAL ROLE myme_app`);

      await pgRequestContext.run({ tx }, async () => {
        await next();
      });
    });
  });
}
