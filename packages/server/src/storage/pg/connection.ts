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
/**
 * Hard ceiling on the session-mode pool, and a ceiling rather than a
 * default: it is `Math.min(maxPoolSize ?? DEFAULT_POOL_MAX_CONNECTIONS,
 * this)`, so
 * `MARFA_DB_POOL_SIZE` can only ever lower it. Nothing raises it.
 *
 * Exported because more than one thing has to be sized against it, and a
 * second copy of the number would drift from this one. Everything that
 * reserves here competes for these five: streaming reads, the consent
 * lock, every job-lock tick, and integration dispatch, which holds its
 * slot for the whole of a dispatch rather than the milliseconds a tick
 * holds one.
 */
export const SESSION_POOL_MAX_CONNECTIONS = 5;

/**
 * The main pool's size when `MARFA_DB_POOL_SIZE` is unset.
 *
 * Exported because `/health` has to know it to say whether the database's
 * connection ceiling still has room for this process's pool to fill, and a
 * second copy of the number would drift from this one.
 */
export const DEFAULT_POOL_MAX_CONNECTIONS = 10;

/**
 * The label this process's connections carry into `pg_stat_activity`.
 *
 * Three places need it and none of them may spell it independently: the
 * pools built below stamp it, and `/health` has to find this process's own
 * app-pool row among every other client's to report how much of the pool is
 * held. A second spelling would not fail — it would attribute this server's
 * own connections to `other` and report a pool that is never in use.
 */
export function pgApplicationName(processRole: string | undefined): string {
  return `marfa-${processRole ?? "both"}`;
}

/**
 * The label a pool carries when whoever built it did not say who it is.
 *
 * **Deliberately outside the space `pgApplicationName` can produce**, which
 * always appends a role. That keeps two things apart that a shared label
 * would merge. `/health` reports `database_connections.pool` by finding this
 * process's own app-pool label among every client in `pg_stat_activity`, so
 * whatever an unnamed pool stamps is what the endpoint counts as its own.
 *
 * Defaulting this through `pgApplicationName` instead reads as the tidier
 * option and is the wrong trade. The callers that pass no label are one-shot
 * admin scripts — seeding, the retired migrations — and each opens a pool of
 * its own. Run co-resident with a server that has no `MARFA_PROCESS_ROLE`,
 * which is the single-container self-host, both would stamp `marfa-both:app`
 * and the script's ten connections would be reported as the server's pool
 * filling up. Production sets `web` and `worker` explicitly and would not
 * have seen it, which is what makes it worth stating rather than assuming.
 *
 * Under this label the same script is reported honestly: it still matches the
 * shape `/health` publishes under its own name, so it appears as its own
 * client rather than folded in with everything else, and it cannot be
 * mistaken for a pool a request competes for. Anything that genuinely is one
 * of the server's own pools passes `applicationName`; the test harness does.
 */
export const PG_UNNAMED_APPLICATION_NAME = "marfa";

/**
 * Every pool this server opens, which is the second half of every
 * `application_name` it stamps.
 *
 * A list rather than five string literals at five call sites, because
 * `/health` has to recognize the labels these produce in order to attribute a
 * connection to the pool that opened it — and a suffix spelled independently
 * at both ends can be renamed at one of them. Renaming `app` here is a type
 * error at every site instead, which is the property the endpoint's
 * attribution depends on and cannot check for itself.
 */
export const PG_POOLS = [
  "app",
  "session",
  "lock",
  "exclusive",
  "consent",
] as const;

export type PgPool = (typeof PG_POOLS)[number];

/**
 * The `application_name` one pool stamps: this process's label, then the pool
 * that opened the connection. The single spelling of that join.
 */
export function pgPoolClient(applicationName: string, pool: PgPool): string {
  return `${applicationName}:${pool}`;
}

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

/**
 * Connections in the pool that holds bracketing exclusive locks.
 *
 * One, and derived rather than picked. A holder's connection does no work
 * beyond holding the lock, and every critical section it admits needs at
 * least one main-pool connection of its own, so sizing this above one buys
 * throughput the main pool has to pay for anyway. What one slot costs is
 * that lifecycle changes serialize per process, which they already do per
 * Connection; what it buys is that a deployment's connection sum stays
 * inside its database tier's ceiling.
 *
 * A queue here drains where a queue on the app pool did not, but the
 * guarantee is weaker than "different pool" makes it sound: a holder
 * progresses only while the app pool can still hand it a connection.
 * What could remove that is enough transaction-riding lock-takers, which
 * is what every mint is, blocked on the same advisory key while each
 * holds an app connection of its own. Splitting web from worker makes
 * that unconstructible, because the mints then queue against a different
 * process's pool than the bracketing holder draws from; `both`, the
 * single-container self-host default, is where it can be built.
 */
const LOCK_POOL_MAX_CONNECTIONS = 1;

/**
 * Seconds the lock pool's connection may sit idle before it is closed.
 *
 * Much shorter than the pools above, because this one is budgeted as a
 * ceiling rather than as a reservation: a deployment's connection sum only
 * stays under its tier's limit if the slot goes back promptly once a
 * lifecycle change finishes. Nothing holds this between lifecycle changes,
 * so steady state is no connection at all.
 *
 * Five seconds rather than one, so a caller that walks several Connections
 * in a row reuses one connection instead of reconnecting per Connection.
 * The auto-upgrade sweep is that caller.
 */
const LOCK_POOL_IDLE_TIMEOUT_SECONDS = 5;

export async function createConnection(
  connectionString: string,
  options?: {
    /** Override the postgres-js pool size. Defaults to 10 — the
     *  production default. Tests pass a small value (3) so parallel
     *  test files don't exhaust PG's cluster-wide `max_connections`
     *  (default 100). */
    maxPoolSize?: number;
    /**
     * Label this process's connections carry into `pg_stat_activity` as
     * their `application_name`, suffixed per client (`:app`, `:session`,
     * `:lock`). It is what lets `/health` say how much of the cluster's
     * connection ceiling this deployment is holding and which pool is
     * holding it — a figure a managed provider does not publish and that a
     * self-hoster has no other route to. Defaults to `marfa`.
     */
    applicationName?: string;
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
  /**
   * Single-connection client for a blocking lock held across a callback.
   * Its one caller today is the Connection lifecycle lock behind
   * `withExclusiveLock`, whose callback runs a multi-step pipeline of
   * queries on the app pool. The lock's own connection therefore has to
   * come from a pool that pipeline never draws from, or concurrent
   * holders deadlock the app pool at its own size. Same endpoint as the
   * app pool, deliberately, and a separate pool on it. Lazy, and it hands
   * the slot back within seconds of a lifecycle change finishing.
   */
  lockClient: PgClient;
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

  const appName = options?.applicationName ?? PG_UNNAMED_APPLICATION_NAME;
  const client = postgres(connectionString, {
    // **This is also the ceiling on concurrent space-scoped requests**, which
    // the name does not say and which is the number a deployment actually
    // runs out of. With RLS enforced, `rlsSpaceContextMiddleware` wraps every
    // request carrying a space in a transaction, and a transaction owns one
    // of these connections until the response is finished. So a process
    // serves at most this many such requests at once and the rest queue —
    // nothing errors, nothing deadlocks, the server simply reads as slow.
    // Production sets three on the web container, so three concurrent
    // space-scoped requests is that tier's entire capacity.
    //
    // Which makes the budget sensitive to how long a handler runs rather than
    // to how much work it does: a handler that waits on something outside
    // this deployment holds its slot for the whole wait, and spends the
    // budget on latency nobody here controls. The streaming routes are
    // exempted from the wrapper for exactly that reason and take their own
    // session-level context instead (`storage/pg/streaming-rls.ts`). Any
    // other handler that waits on a third party inside the wrapper is
    // spending this budget while it waits, and `POST /connections/{id}/
    // proxy/*` is the one that does.
    //
    // So sizing this pool against the database's connection ceiling answers
    // only half the question. The count is what competes for `max_connections`
    // and is the number to hold under the tier's limit; how long each slot is
    // held is what decides whether the pool is a pool or a queue, and no
    // connection budget can see that.
    max: options?.maxPoolSize ?? DEFAULT_POOL_MAX_CONNECTIONS,
    connection: { application_name: pgPoolClient(appName, "app") },
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
    // stream plus one per in-flight `withJobLock` tick. The
    // process-lifetime holder is not among them; it lives on
    // `jobHolderClient`, never here. This stays small, because the
    // endpoints it can point at have tight connection ceilings, and a
    // reservation that cannot be served times out rather than queueing
    // forever.
    //
    // Job ticks are mostly short and one of them is not: a connection
    // dispatch holds its slot for the whole of its dispatch, which is
    // tens of seconds rather than milliseconds. A deployment sizing this
    // against tick count alone is sizing against the wrong number, so
    // count concurrent dispatch as a stream.
    //
    // Note what this pool's size does not explain. A reservation can be
    // destroyed rather than queued when a connection closes, and then it
    // is never granted however free the pool is. `reserve-timeout.ts`
    // carries the mechanism and the second ask that answers it. Raising
    // `max` does nothing for that one, and it reaches every client here,
    // including the single-connection one below.
    max: Math.min(
      options?.maxPoolSize ?? DEFAULT_POOL_MAX_CONNECTIONS,
      SESSION_POOL_MAX_CONNECTIONS,
    ),
    connection: { application_name: pgPoolClient(appName, "session") },
    // Same reasoning as the app pool. This one matters more per socket:
    // between streams it holds its slots open with nothing to show for it.
    idle_timeout: POOL_IDLE_TIMEOUT_SECONDS,
    max_lifetime: POOL_MAX_LIFETIME_SECONDS,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  const jobHolderClient = postgres(sessionModeUrl, {
    max: 1,
    connection: { application_name: pgPoolClient(appName, "lock") },
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
  // The bracketing exclusive lock's own pool. `withExclusiveLock` holds a
  // transaction for the whole of its callback, and that callback runs its
  // own queries on the app pool, so the lock's connection must not come
  // from there: concurrent callers would each hold an app slot while
  // waiting for an app slot nobody can release. That is the same
  // bracketing deadlock the clients above exist to avoid, reached at pool
  // size rather than at load, and it was reached: three concurrent
  // Connection uninstalls against a three-connection pool took every slot
  // and the server stopped answering.
  //
  // **The app endpoint, unlike its two neighbours above.** They take the
  // session-mode URL because they need a real session: streaming holds
  // `SET ROLE` on a reserved backend, and the election holds one lock for
  // the process lifetime. This lock needs neither. It is transaction-
  // scoped, and a transaction is the unit a pooler keeps on one backend,
  // so it is correct on a pooled endpoint by construction.
  //
  // Taking the session-mode URL instead would put this key on a different
  // endpoint from the mints, which take it on the app pool through the
  // caller's own transaction. Two endpoints exclude each other only if
  // they reach the same database, and nothing establishes that:
  // `endpoint.ts` compares host and port, so a direct URL naming another
  // database on the same host passes every check. Exclusion would stop
  // being structural and become an unchecked invariant whose failure is
  // silent — a mint and an uninstall both believing they hold the lock.
  // Sharing the app endpoint keeps the two on one database because it is
  // one string.
  //
  // Lazy, like the others, so a deployment that never changes a Connection
  // lifecycle never opens it.
  const lockClient = postgres(connectionString, {
    max: LOCK_POOL_MAX_CONNECTIONS,
    connection: { application_name: pgPoolClient(appName, "exclusive") },
    idle_timeout: LOCK_POOL_IDLE_TIMEOUT_SECONDS,
    max_lifetime: POOL_MAX_LIFETIME_SECONDS,
    // Same reasoning as the app client, and it applies here for the same
    // reason the endpoint choice is safe: this client shares that
    // endpoint. A named prepared statement lives on the backend that saw
    // the PREPARE, and behind a transaction-mode pooler this client's
    // next transaction need not land there.
    prepare: options?.poolMode !== "transaction",
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
    lockClient,
    close: async () => {
      // Bounded ends: a plain `end()` waits for reserved connections to be
      // released, and shutdown must not depend on every holder having
      // behaved — a bridge election reservation or a stream that missed
      // its release would otherwise stall close past its budget. Tracked
      // in-flight writes have already drained by the time this runs (see
      // the storage-level close wrapper). In parallel, so the whole close
      // is bounded by the one-second force rather than their sum — three
      // serial worst cases already exactly consumed the shutdown step's
      // budget and reproduced the warn this bound exists to remove, and
      // there are four clients now.
      await Promise.all([
        client.end({ timeout: 1 }),
        sessionClient.end({ timeout: 1 }),
        jobHolderClient.end({ timeout: 1 }),
        lockClient.end({ timeout: 1 }),
      ]);
    },
  };
}
