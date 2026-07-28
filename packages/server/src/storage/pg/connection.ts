import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { DbPoolMode } from "../../config.js";
import { stampPgDrizzleMigrations } from "../bootstrap-stamp.js";
import { isSamePgEndpoint, pgEndpointLabel } from "./endpoint.js";
import { wrapDbWithRequestContext } from "./request-context.js";
import { SCHEMA_SQL } from "./schema-sql.generated.js";

export type PgDb = ReturnType<typeof drizzle<typeof schema>>;
export type PgClient = ReturnType<typeof postgres>;

/**
 * Seconds a pooled connection may sit idle before postgres.js closes it.
 *
 * The library default is `null` — never close — which means the pool holds its
 * sockets open for the life of the process. Against a serverless Postgres that
 * is a standing charge: a compute that scales to zero only does so when it has
 * **no connections at all**, so an idle pool bills continuously whether or not
 * anything is being served. An always-idle deployment costs the same as a busy
 * one, and the compute-hour budget goes on being switched on.
 *
 * 30 seconds is chosen against two measured numbers. Reconnecting to an already
 * awake compute costs well under a second, and only after a full 30s lull, so a
 * normal interactive session never churns connections. Waking a **suspended**
 * compute measured at roughly 0.6–1.1s on top of that — but that cost is only
 * reachable after the provider's own idle timer (5 minutes by default) has also
 * run down, and any gap that long has already scaled the container itself to
 * zero, so the two waits land on the same unlucky request rather than stacking
 * on separate ones. The value only has to be comfortably under the provider's
 * timer for scale-to-zero to become reachable at all; the rest is headroom.
 *
 * One value suits both deployment shapes, so this is not configurable: against
 * a Postgres on the same host or in the same cluster a reconnect is a rounding
 * error, which makes the timeout harmless for a self-host, while for a hosted
 * serverless database it is the entire point.
 *
 * Reserved connections are exempt by construction — postgres.js cancels the
 * idle timer whenever a connection leaves the idle queue — so a long-lived
 * streaming RLS reservation is never closed out from under an open stream.
 */
const POOL_IDLE_TIMEOUT_SECONDS = 30;

/**
 * Seconds a connection may live before it is recycled, idle or not.
 *
 * postgres.js already defaults this to a jittered 30–60 minutes, so this is a
 * pin rather than a new behavior: it keeps the value visible next to the idle
 * timeout it belongs with, and stops a dependency bump moving it silently.
 * Recycling bounds how long any one socket can accumulate server-side session
 * state or sit behind an intermediary that has quietly stopped forwarding it.
 *
 * With the idle timeout above, only a connection that stays continuously busy
 * ever reaches this age. Recycling is deferred while a connection is reserved,
 * so this cannot interrupt a stream mid-flight either.
 */
const POOL_MAX_LIFETIME_SECONDS = 30 * 60;

export async function createConnection(
  connectionString: string,
  options?: {
    /** Override the postgres-js pool size. Defaults to 10 — the
     *  production default. Tests pass a small value (3) so parallel
     *  test files don't exhaust PG's cluster-wide `max_connections`
     *  (default 100). */
    maxPoolSize?: number;
    /** Skip the bootstrap `SCHEMA_SQL` + migration-journal stamp.
     *  Tests against a database cloned from a pre-built template
     *  (`createPgTestStorage`) already have the schema applied; running
     *  SCHEMA_SQL again is idempotent but takes hundreds of milliseconds
     *  per storage instance and serializes across two storages on the
     *  same DB via the advisory lock — meaningful overhead at scale.
     *  Defaults to false (production behavior preserved). */
    skipBootstrap?: boolean;
    /**
     * Direct (session-mode) connection string used ONLY for streaming RLS
     * reservations. Streaming issues a SESSION-level `SET ROLE marfa_app`;
     * over a transaction-mode pooler (Neon's pooled endpoint — the app's
     * `DATABASE_URL`) that role strands on a shared PgBouncer backend and is
     * inherited by a later, unrelated query, which then hits RLS as the
     * restricted role. Pointing streaming at the direct, unpooled endpoint
     * keeps the reserve → SET ROLE → reset cycle 1:1 with a real backend, so
     * nothing strands on the app pool.
     *
     * Required when `poolMode` is `transaction`; optional otherwise, and
     * streaming then reuses the main client.
     */
    directConnectionString?: string;
    /**
     * What kind of endpoint `connectionString` points at. Defaults to
     * `session` — a direct Postgres connection, where streaming can safely
     * share the main client. See `DbPoolMode`.
     */
    poolMode?: DbPoolMode;
  },
): Promise<{
  /**
   * Drizzle instance wrapped with the per-request context proxy.
   * Storage classes consume this so per-request transactions (set up
   * by the RLS middleware) transparently substitute. Use for everything
   * except Better Auth.
   */
  db: PgDb;
  /**
   * Unwrapped base Drizzle instance — bypasses the per-request
   * context. Reserved for Better Auth, which manages its own
   * connection / cookie context outside the data-plane request
   * middleware. Auth tables (`auth_*`) have no RLS policies and
   * always operate as the connection owner.
   */
  baseDb: PgDb;
  client: PgClient;
  /**
   * Dedicated client for streaming RLS reservations. A separate small pool
   * on the direct (session-mode) endpoint when `directConnectionString` is
   * set; otherwise the same `client`. Only `acquireStreamRls` reserves from
   * it — never the data plane or Better Auth.
   */
  streamClient: PgClient;
  close: () => Promise<void>;
}> {
  const directConnectionString = options?.directConnectionString?.trim() ?? "";

  // Fail closed before opening anything. On a transaction-mode pooler,
  // "no direct endpoint" cannot mean "share the pooled client": streaming's
  // session-level SET ROLE would strand on a shared backend and be inherited
  // by unrelated queries across the whole instance. Silently disabling
  // streaming RLS instead would trade a loud failure for a quiet loss of
  // tenant isolation, so neither fallback is acceptable.
  if (options?.poolMode === "transaction" && directConnectionString === "") {
    throw new Error(
      "MARFA_DATABASE_URL_DIRECT is required when MARFA_DB_POOL_MODE=transaction. " +
        "Streaming RLS must reserve from a direct (unpooled) endpoint, not the " +
        "transaction-mode pooled one DATABASE_URL points at.",
    );
  }

  // "Set" is not the same as "direct". Pointing the direct variable back at the
  // pooled endpoint satisfies the presence check above, builds a second pool
  // that is distinct from the app's, logs itself as `direct`, and still strands
  // the role — every observable signal reads healthy while the outage is
  // reproduced exactly. Nothing downstream can tell the difference, so the
  // difference has to be established here.
  if (
    options?.poolMode === "transaction" &&
    isSamePgEndpoint(connectionString, directConnectionString)
  ) {
    throw new Error(
      "MARFA_DATABASE_URL_DIRECT points at the same endpoint as DATABASE_URL " +
        `(${pgEndpointLabel(directConnectionString)}), so it is the pooled one. ` +
        "Streaming RLS needs an endpoint that owns its backend outright; a " +
        "session-level SET ROLE over a transaction-mode pooler strands on a " +
        "shared backend. On Neon the direct host is the pooled host without " +
        "the `-pooler` suffix.",
    );
  }

  const client = postgres(connectionString, {
    max: options?.maxPoolSize ?? 10,
    idle_timeout: POOL_IDLE_TIMEOUT_SECONDS,
    max_lifetime: POOL_MAX_LIFETIME_SECONDS,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  // Dedicated streaming client on the direct (session-mode) endpoint, when
  // configured, so streaming's session-level `SET ROLE` never strands on the
  // app's transaction-mode pooled connections (see `directConnectionString`).
  const streamClient = directConnectionString
    ? postgres(directConnectionString, {
        // One slot per concurrent stream; streams are far rarer than
        // data-plane requests and the direct endpoint has a tighter
        // connection ceiling than the pooler.
        max: Math.min(options?.maxPoolSize ?? 10, 5),
        // Same reasoning as the app pool. This one matters more per socket:
        // between streams it holds its slots open with nothing to show for it.
        idle_timeout: POOL_IDLE_TIMEOUT_SECONDS,
        max_lifetime: POOL_MAX_LIFETIME_SECONDS,
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        onnotice: () => {},
      })
    : client;
  const baseDb = drizzle(client, { schema });
  const db = wrapDbWithRequestContext(baseDb);

  // Apply schema under an advisory lock to prevent concurrent DDL races.
  // SCHEMA_SQL is the fresh-database bootstrap path, auto-generated from
  // drizzle/pg/ migrations by scripts/generate-schema-sql.ts. RLS role +
  // policies are included; activation requires MARFA_RLS_ENFORCE=true.
  if (!options?.skipBootstrap) {
    await client.unsafe(`SELECT pg_advisory_lock(42)`);
    try {
      await client.unsafe(SCHEMA_SQL);
      // Stamp __drizzle_migrations so a follow-up `pnpm migrate` short-circuits. Idempotent.
      await stampPgDrizzleMigrations(client);
    } finally {
      await client.unsafe(`SELECT pg_advisory_unlock(42)`);
    }
  }

  return {
    db,
    baseDb,
    client,
    streamClient,
    close: async () => {
      await client.end();
      if (streamClient !== client) {
        await streamClient.end();
      }
    },
  };
}
