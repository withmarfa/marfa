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
   * Dedicated client for work that needs a real session. A separate small
   * pool on the direct (session-mode) endpoint when `directConnectionString`
   * is set; otherwise the same `client`. Two callers reserve from it and no
   * others: `acquireStreamRls`, whose `SET ROLE` is session state, and
   * `withJobLock`, whose `pg_try_advisory_lock` is a session-scoped lock.
   * Never the data plane, never Better Auth.
   */
  sessionClient: PgClient;
  /**
   * Single-connection client for a lock held for the process lifetime —
   * today the reactive-run bridge's drainer election. Held reservations
   * are capacity subtracted from whatever pool they come from, and the
   * drainer once quietly took a fifth of the session pool for the whole
   * process, so the permanent holder gets a pool of its own. Lazy: the
   * connection opens on first use, so a deployment with the bridge
   * disabled never pays for it.
   */
  jobHolderClient: PgClient;
  close: () => Promise<void>;
}> {
  const directConnectionString = options?.directConnectionString?.trim() ?? "";

  // Fail closed before opening anything. On a transaction-mode pooler,
  // "no direct endpoint" cannot mean "share the pooled client": streaming's
  // session-level SET ROLE would strand on a shared backend and be inherited
  // by unrelated queries across the whole instance. Silently disabling
  // streaming RLS instead would trade a loud failure for a quiet loss of
  // space isolation, so neither fallback is acceptable.
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
    // Named prepared statements live on the backend that saw the PREPARE.
    // Behind a transaction-mode pooler the next statement's backend need
    // not be that one, so execution fails intermittently with "prepared
    // statement ... does not exist" — a shape that reads as flakiness and
    // has produced production errors. The driver defaults `prepare` to
    // true, so the pool mode has to reach this constructor rather than
    // dying at the guards above. The direct clients below own their
    // backends for a connection's lifetime and keep preparation.
    prepare: options?.poolMode !== "transaction",
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  // Dedicated clients for the work that genuinely needs a connection of its
  // own: streaming's `SET ROLE` reservations, the short-hold advisory locks
  // behind `withJobLock`, and the process-lifetime election reservation
  // behind `withLongLivedJobLock`. On a transaction-mode pooler these must
  // take the direct endpoint (a statement there is its own transaction, so
  // session state strands — see `directConnectionString`); on a plain
  // session-mode deployment they take the app's own endpoint but still get
  // their own pools. They used to alias the app pool in that shape, which
  // put a bracketing lock's connection and the queries its critical section
  // runs in one pool — the documented bracketing deadlock, reached at pool
  // size rather than load, and reached in practice the moment role-split
  // deployments shrank the app pool: one held election reservation plus a
  // single job tick wedged a two-connection pool permanently. A lock's
  // connection must come from a pool the locked work never queries,
  // whatever the endpoint topology.
  const sessionModeUrl = directConnectionString || connectionString;
  const sessionClient = postgres(sessionModeUrl, {
    // Sized against what reserves from it: one slot per concurrent
    // stream plus one per in-flight `withJobLock` tick (job ticks are
    // short; the process-lifetime holder lives on `jobHolderClient`,
    // never here). This stays small — the endpoints it can point at have
    // tight connection ceilings — and a reservation that cannot be
    // served times out rather than queueing forever.
    max: Math.min(options?.maxPoolSize ?? 10, 5),
    // Same reasoning as the app pool. This one matters more per socket:
    // between streams it holds its slots open with nothing to show for it.
    idle_timeout: POOL_IDLE_TIMEOUT_SECONDS,
    max_lifetime: POOL_MAX_LIFETIME_SECONDS,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  const jobHolderClient = postgres(sessionModeUrl, {
    max: 1,
    // The idle timeout only ever fires on a process that lost the
    // election and released its reservation — a held reservation is
    // exempt by construction — so the loser's probe connection closes
    // instead of lingering for the process lifetime.
    idle_timeout: POOL_IDLE_TIMEOUT_SECONDS,
    // No max lifetime: the winner's reservation is held for the process
    // lifetime and must not be lifecycled out from under it.
    max_lifetime: null,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  const baseDb = drizzle(client, { schema });
  const db = wrapDbWithRequestContext(baseDb);

  // Apply schema under an advisory lock to prevent concurrent DDL races.
  // SCHEMA_SQL is the fresh-database bootstrap path, auto-generated from
  // drizzle/pg/ migrations by scripts/generate-schema-sql.ts. RLS role +
  // policies are included; activation requires MARFA_RLS_ENFORCE=true.
  if (!options?.skipBootstrap) {
    // Transaction-scoped lock, taken inside an explicit transaction, for the
    // same reason `PgCoordinationStore.withExclusiveLock` uses one.
    //
    // `pg_advisory_lock` is session-scoped, and a session-scoped lock needs a
    // session, which a pooled endpoint is not. Behind a transaction-mode
    // pooler each bare statement is its own transaction, so the acquire lands
    // on whichever backend happened to be free and the matching unlock need
    // not reach it. Measured against PgBouncer, that shape lets two callers
    // hold one lock and leaves a lock alive past the client that took it.
    // This runs on every real boot, which is exactly when concurrent DDL
    // would race.
    //
    // A transaction is the unit a pooler keeps on one backend, and it
    // releases on commit, rollback or disconnect rather than on a statement
    // arriving somewhere. Putting the DDL inside it is not incidental: the
    // lock only covers the bootstrap if the bootstrap is in the transaction
    // that holds it, and the whole schema apply becomes atomic as a result.
    await client.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(42)`);
      await tx.unsafe(SCHEMA_SQL);
      // Stamp __drizzle_migrations so a follow-up `pnpm migrate` short-circuits. Idempotent.
      await stampPgDrizzleMigrations(tx);
    });
  }

  return {
    db,
    baseDb,
    client,
    sessionClient,
    jobHolderClient,
    close: async () => {
      await client.end();
      if (sessionClient !== client) {
        await sessionClient.end();
      }
      if (jobHolderClient !== client) {
        await jobHolderClient.end();
      }
    },
  };
}
