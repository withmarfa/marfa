import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { platformDrift } from "../storage/platform-drift.js";
import { storedValueScan } from "../storage/stored-value-scan.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import type { AppConfig } from "../config.js";
import type { MarfaAuth } from "../auth/instance.js";
import type { OidcProviderHealth } from "../auth/oidc-availability.js";
import {
  DEFAULT_POOL_MAX_CONNECTIONS,
  pgApplicationName,
  type PgClient,
} from "../storage/pg/connection.js";

interface ComponentStatus {
  status: "ok" | "degraded" | "down";
  latency_ms?: number;
  error?: string;
  /** Per-provider detail, present only on `identity_providers`. */
  providers?: OidcProviderHealth[];
  /** How many dispatches have given up, present only on `dead_letters`. */
  count?: number;
}

/** Where the platform says this instance is running. */
interface Placement {
  region?: string;
  location?: string;
  country?: string;
}

/**
 * Read the placement this deployment states about itself. The variables are
 * platform-neutral and set per environment, so the answer describes where the
 * server actually runs rather than which provider it runs on, and a
 * self-hoster can set them without pretending to be on one. Unset means the
 * block is absent rather than carrying empty strings that would read as a
 * real answer.
 *
 * It is here because placement is otherwise invisible from outside the
 * platform's own API, and getting it wrong produces no error, no failed
 * deploy and no degraded status — only latency, against a database that then
 * takes the blame. Production ran a continent away from its data for four
 * months while every check stayed green, and the one field that would have
 * said so did not exist.
 *
 * These replaced a set of provider-supplied variables the container runtime
 * populated on its own. That was cheaper to operate and is exactly why the
 * field vanished when the deployment moved: nothing outside that provider
 * sets them, so the check went quiet without ever failing. A stated value is
 * worth the three lines of configuration it costs.
 */
function readPlacement(): Placement | null {
  const region = process.env.MARFA_PLACEMENT_REGION;
  const location = process.env.MARFA_PLACEMENT_LOCATION;
  const country = process.env.MARFA_PLACEMENT_COUNTRY;
  if (!region && !location && !country) return null;
  return {
    ...(region && { region }),
    ...(location && { location }),
    ...(country && { country }),
  };
}

/**
 * How much of the database's connection ceiling this deployment is holding,
 * and which pool is holding it.
 */
interface DatabaseConnections {
  /** Connections to this database from every client, Marfa's or not. */
  total: number;
  /**
   * The number `total` is actually racing: `max_connections` less the slots
   * held back for superusers, which an ordinary client can never have.
   *
   * Reporting `max_connections` alone would overstate the headroom, and on
   * the managed tier that is not a rounding error — it advertises 25 while
   * reserving 3, so the figure that matters is 22. A watcher alerting at
   * 90% of the wrong number fires after exhaustion rather than before it,
   * which is the exact failure this endpoint exists to give warning of.
   */
  ceiling: number;
  /** `max_connections` verbatim, so the arithmetic above is visible rather
   *  than something a reader has to trust. */
  max_connections: number;
  /** Slots held back by `superuser_reserved_connections`. */
  reserved: number;
  /** Counts by backend state, keyed by client. Marfa's own pools are named
   *  (`marfa-web:app`, `marfa-worker:lock`); anything else is `other`.
   *  A pool of Marfa's own that sets no `application_name` lands in
   *  `other` too, which reads as another client's traffic rather than as
   *  a gap here. */
  clients: Record<string, Record<string, number>>;
  /**
   * This process's own query pool, which is the one a request competes
   * for. The figures above are the whole database and answer a different
   * question: a cluster with plenty of headroom can still be serving a
   * container whose own three slots are all taken.
   */
  pool: PoolUsage;
}

/** How much of one process's query pool is spoken for. */
interface PoolUsage {
  /** `MARFA_DB_POOL_SIZE`, or the built-in default. */
  size: number;
  /**
   * Connections this pool holds in any state but `idle`. A connection
   * sitting `idle` is in the pool and free; anything else is spoken for,
   * including one not yet opened, which is why this is counted rather
   * than subtracted from the number of sockets.
   */
  in_use: number;
  /**
   * Of those, the ones an open transaction holds without running a query.
   *
   * The distinction that separates busy from wedged, and the reason state
   * is read rather than a bare count. A pool full of `active` backends is
   * doing work and will hand the slots back. A pool full of these is
   * holding connections while waiting on something that is not the
   * database — which is what the RLS request transaction does for the
   * whole of a handler, including any wait on a third party inside it.
   */
  idle_in_transaction: number;
  /** `size - in_use`. Zero is the pool fully held: the next query queues. */
  free: number;
}

/**
 * How long a component probe may take before this endpoint stops waiting
 * on it and reports what it knows.
 *
 * A liveness answer that waits is not a liveness answer. Both probes below
 * are unbounded by nature — the database probe queues for a pool slot, and
 * postgres.js queues an unavailable reservation with no bound at all, while
 * the blob probe is a network round trip. So when the pool was fully held,
 * `/health` did not report a busy server: it never answered, for fifty-two
 * seconds and then a 500, while ordinary requests were still being served.
 * The one endpoint whose job is to say how things are was the only one that
 * could not say anything.
 *
 * Two seconds is well past a healthy answer (single-digit milliseconds) and
 * well short of any caller's patience.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/** Marker for a probe that outran its budget rather than failing. */
const TIMED_OUT = Symbol("probe-timed-out");

/**
 * Race a probe against the budget. A probe that loses keeps running — it
 * holds a pool slot or a socket we cannot reclaim — so its eventual
 * rejection is swallowed deliberately: it belongs to an answer nobody is
 * waiting for any more, and an unhandled rejection would take the process
 * down over a health check.
 */
async function withBudget<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolveBudget) => {
    timer = setTimeout(() => {
      resolveBudget(TIMED_OUT);
    }, PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      work.catch((err: unknown) => {
        throw err;
      }),
      budget,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * How long a connection reading may be cached before it is taken again.
 *
 * The compose healthcheck hits `/health` far more often than any external
 * watcher does, and this probe costs a pool slot — the resource it exists to
 * measure. Fifteen seconds keeps the figure current enough to watch a pool
 * fill while making the probe a rounding error against the traffic that
 * asks for it.
 */
const CONNECTIONS_CACHE_MS = 15_000;

/**
 * Read how many connections this database is carrying, from the database's
 * own view of them.
 *
 * The driver is postgres.js, which keeps its pool queues module-local and
 * exposes nothing to count — the pool-depth properties an operator expects
 * belong to a different client library that this server does not use. So the
 * count comes from `pg_stat_activity` instead, which is a better answer
 * anyway: it sees every connection to the database whatever opened it, so the
 * web container reports the whole deployment's usage against the ceiling
 * rather than only its own share, and a self-hoster's `psql` session shows up
 * in the same total that is racing `max_connections`.
 *
 * Two limits worth knowing. A non-superuser sees every row but only reads
 * `application_name` and `state` for backends belonging to its own role, so
 * anything connecting as another role lands in `other` — the total stays
 * right, the attribution does not claim more than it knows. And the reading
 * is omitted rather than guessed when the probe cannot complete: a pool held
 * hard enough to starve this query has already failed the database component
 * above, which is what a watcher alerts on. The value here is watching the
 * number climb toward the ceiling beforehand.
 */
/** The `application_name` shape this server sets: an optional role suffix
 *  on the base label, then the pool that opened the connection. Four come
 *  from `createConnection`; the fifth, `consent`, is built in `index.ts`,
 *  so a new pool anywhere needs adding here or it reports as somebody
 *  else's traffic. */
const MARFA_CLIENT = /^marfa(-[a-z]+)?:(app|session|lock|exclusive|consent)$/;

/** A backend sitting in the pool, free to be handed out. */
const IDLE_STATE = "idle";
/** `idle in transaction` and `idle in transaction (aborted)`. */
const IDLE_IN_TRANSACTION_PREFIX = "idle in transaction";

async function readDatabaseConnections(
  client: PgClient,
  /** This process's own app-pool label, to find its row among the rest. */
  appClient: string,
  poolSize: number,
): Promise<DatabaseConnections> {
  const rows = (await client`
    select
      coalesce(nullif(application_name, ''), 'other') as client,
      coalesce(state, 'unknown') as state,
      count(*)::int as connections,
      current_setting('max_connections')::int as max_connections,
      current_setting('superuser_reserved_connections')::int as reserved
    from pg_stat_activity
    where datname = current_database()
    group by 1, 2
  `) as unknown as {
    client: string;
    state: string;
    connections: number;
    max_connections: number;
    reserved: number;
  }[];

  const clients: Record<string, Record<string, number>> = {};
  let total = 0;
  let maxConnections = 0;
  let reserved = 0;
  for (const row of rows) {
    // Only Marfa's own pools are reported under their own name, matched
    // against the shape this server sets rather than a loose prefix. Every
    // other client folds into one bucket: the ceiling is shared so the count
    // matters, but this endpoint is unauthenticated and has no business
    // publishing arbitrary connection labels from someone else's cluster.
    const key = MARFA_CLIENT.test(row.client) ? row.client : "other";
    const byState = (clients[key] ??= {});
    byState[row.state] = (byState[row.state] ?? 0) + row.connections;
    total += row.connections;
    maxConnections = row.max_connections;
    reserved = row.reserved;
  }
  const own = clients[appClient] ?? {};
  let inUse = 0;
  let idleInTransaction = 0;
  for (const [state, count] of Object.entries(own)) {
    if (state === IDLE_STATE) continue;
    inUse += count;
    if (state.startsWith(IDLE_IN_TRANSACTION_PREFIX))
      idleInTransaction += count;
  }

  return {
    total,
    ceiling: Math.max(0, maxConnections - reserved),
    max_connections: maxConnections,
    reserved,
    clients,
    pool: {
      size: poolSize,
      in_use: inUse,
      idle_in_transaction: idleInTransaction,
      // Floored, because the reading and the size come from different
      // places: a pool mid-recycle can briefly hold one more backend than
      // its size, and a negative free slot count is not a thing to publish.
      free: Math.max(0, poolSize - inUse),
    },
  };
}

/**
 * Why the database component may report `degraded` while the probe itself
 * still answers.
 *
 * Deciding between `ok` and `degraded` on whether one probe came back inside
 * its budget makes the first signal of exhaustion arrive after exhaustion. A
 * pool with one slot left answers exactly as fast as an idle one, so the
 * endpoint stayed green right up to the point where it could say nothing at
 * all — by which time every other request had been queuing for minutes. The
 * counts needed to do better were already being gathered and published; what
 * was missing was a verdict on them.
 *
 * **The verdict is that the pool has no free slot while the probe still
 * answers.** That is a state strictly between healthy and gone: the database
 * is reachable and quick, and the next query still has to wait for a slot
 * rather than getting one. It is also unambiguous in a way a threshold is
 * not — a pool holding one idle connection, or with one slot it has not
 * opened, reports `ok`, so nothing here fires on a pool that is merely busy.
 *
 * **Why not a threshold, when the ticket's own words are "one slot left".**
 * The pools here are three and two, so every threshold between "some" and
 * "none" is one request wide, and a component that degrades on one
 * concurrent request is one an operator learns to ignore — which this file
 * already has a rule about. The climb toward the limit is published instead,
 * as `database_connections.pool`, where a watcher can graph `free` falling
 * and `idle_in_transaction` rising without the endpoint having to shout.
 * Reporting a number and degrading on a state is the split this file draws
 * everywhere else.
 *
 * Returns the reason, or `null` when there is nothing to report. A pool with
 * no size to compare against is not a reading and says nothing either way.
 */
function poolExhausted(connections: DatabaseConnections): string | null {
  const pool = connections.pool;
  if (pool.size <= 0) return null;
  if (pool.free > 0) return null;
  const held =
    pool.idle_in_transaction > 0
      ? `, ${String(pool.idle_in_transaction)} of them held by an open transaction rather than running a query`
      : "";
  return (
    `all ${String(pool.size)} pool connections are in use` +
    `${held} — further queries queue for a slot rather than getting one`
  );
}

export function healthRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
  getAuth?: () => MarfaAuth | undefined,
  /**
   * How many dispatches have given up, when this deployment runs the local
   * substrate. Absent otherwise, and the component is then absent too
   * rather than reporting a reassuring zero for a queue that does not
   * exist.
   */
  countDeadLetters?: (() => Promise<number>) | null,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Undefined on SQLite, where there is no pool and no `pg_stat_activity`
  // to read, so the block is absent rather than zeroed. Cast at the
  // consumer site, matching how the other escape hatches on `Storage` are
  // consumed.
  const pgClient = storage.pgClient as PgClient | undefined;
  // This process's own app-pool label and size, resolved once. Both are
  // fixed for the life of the process, and the label has to match what the
  // pools actually stamp or the reading attributes this server to `other`.
  const appPoolClient = `${pgApplicationName(config.processRole)}:app`;
  const appPoolSize = config.dbPoolSize ?? DEFAULT_POOL_MAX_CONNECTIONS;
  let connectionsCache: { at: number; value: DatabaseConnections } | null =
    null;
  let deadLettersCache: { at: number; value: number } | null = null;

  // Read once rather than per request. The file cannot change under a
  // running process — a new build is a new container — and a liveness
  // endpoint should not reach the disk to answer.
  let versionCache: Record<string, unknown> | null | undefined;
  const readVersion = async (): Promise<Record<string, unknown> | null> => {
    if (versionCache !== undefined) return versionCache;
    try {
      const raw = await readFile(
        resolve(process.cwd(), "version.json"),
        "utf-8",
      );
      versionCache = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No version file — normal in development.
      versionCache = null;
    }
    return versionCache;
  };

  router.get("/", async (c) => {
    const components: Record<string, ComponentStatus> = {};
    let overall: "ok" | "degraded" = "ok";

    // How much of the connection ceiling this deployment is holding. Pool
    // exhaustion has taken this deployment down twice and nothing published
    // the number that would have shown either coming — the provider offers
    // no connection-count metric at all, so the server that owns the pools
    // is the only thing that can say.
    //
    // Read before the database component below, because that component's
    // verdict is taken from these figures. It used to sit after them, when
    // it was a report nothing consulted.
    //
    // The reading is still published as a block of its own carrying no
    // status, which it keeps: `components.database` is where the verdict
    // belongs, and two places saying the same thing in different words is
    // how a watcher ends up keyed on the wrong one.
    let databaseConnections: DatabaseConnections | undefined;
    if (pgClient) {
      const cached = connectionsCache;
      if (cached && performance.now() - cached.at < CONNECTIONS_CACHE_MS) {
        databaseConnections = cached.value;
      } else {
        try {
          const outcome = await withBudget(
            readDatabaseConnections(pgClient, appPoolClient, appPoolSize),
          );
          if (outcome !== TIMED_OUT) {
            databaseConnections = outcome;
            connectionsCache = { at: performance.now(), value: outcome };
          }
        } catch {
          // Omitted rather than guessed. Whatever stopped this from
          // answering is what the database component below reports on, and
          // it falls back to the probe's own answer when there is no
          // reading to judge.
        }
      }
    }

    // Database. `down` and `degraded` are different answers and the
    // difference is the useful part: `down` means the database refused,
    // `degraded` means we could not get an answer inside the budget, which
    // is what pool exhaustion looks like from here.
    //
    // Latency rides every branch rather than only the healthy one. A probe
    // that failed after 1.9 seconds and one that failed in 5ms are different
    // faults, and the branch that reported no number was the one where the
    // number said most. On the timed-out branch it is the budget by
    // construction, which is worth publishing anyway: a watcher graphing this
    // sees the climb and then the cap rather than a gap.
    const dbStart = performance.now();
    try {
      const outcome = await withBudget(storage.keys.count());
      const latencyMs = Math.round(performance.now() - dbStart);
      if (outcome === TIMED_OUT) {
        components.database = {
          status: "degraded",
          latency_ms: latencyMs,
          error: `no answer within ${String(PROBE_TIMEOUT_MS)}ms — the connection pool may be fully held`,
        };
      } else {
        // The probe answered, which used to be the whole question. It is
        // now the first of two: a pool with no slot left answers just as
        // quickly as an idle one, so the answer alone cannot tell them
        // apart. The reading may be up to `CONNECTIONS_CACHE_MS` old, so a
        // pool that has since cleared can still be reported held for that
        // long — the alternative is taking a slot per health check to
        // measure the slots, which is the probe this cache exists to avoid.
        const exhausted = databaseConnections
          ? poolExhausted(databaseConnections)
          : null;
        components.database = exhausted
          ? { status: "degraded", latency_ms: latencyMs, error: exhausted }
          : { status: "ok", latency_ms: latencyMs };
      }
    } catch (err) {
      components.database = {
        status: "down",
        latency_ms: Math.round(performance.now() - dbStart),
        error: err instanceof Error ? err.message : "unknown",
      };
    }
    if (components.database.status !== "ok") overall = "degraded";

    // Blob storage. Same budget, and the same reason for one: on the
    // hosted deployment this is a network call to object storage.
    const blobStart = performance.now();
    try {
      const outcome = await withBudget(
        blobBackend.exists("sha256:healthcheck"),
      );
      components.blob_storage =
        outcome === TIMED_OUT
          ? {
              status: "degraded",
              error: `no answer within ${String(PROBE_TIMEOUT_MS)}ms`,
            }
          : {
              status: "ok",
              latency_ms: Math.round(performance.now() - blobStart),
            };
    } catch (err) {
      components.blob_storage = {
        status: "down",
        error: err instanceof Error ? err.message : "unknown",
      };
    }
    if (components.blob_storage.status !== "ok") overall = "degraded";

    // Federated identity providers. A provider whose discovery could not
    // be reached degrades rather than taking the server down, so this is
    // the surface that says so — without it the degradation would only
    // be visible in container output, which is the failure mode the rule
    // against silent degradation exists to prevent. Absent entirely when
    // no federated provider is configured. Costs nothing to read: it is a
    // snapshot of an in-process map.
    const providers = getAuth?.()?.oidcHealth() ?? [];
    if (providers.length > 0) {
      const unavailable = providers.filter((p) => p.status === "unavailable");
      components.identity_providers = {
        status: unavailable.length === 0 ? "ok" : "degraded",
        providers,
        ...(unavailable.length > 0 && {
          error: `${String(unavailable.length)} of ${String(providers.length)} unavailable: ${unavailable
            .map((p) => p.provider_id)
            .join(", ")}`,
        }),
      };
      if (unavailable.length > 0) overall = "degraded";
    }

    // A dispatch that exhausted its retries is the system saying it gave
    // up, and until this it announced that nowhere. One sat in the live
    // staging space for thirty-three hours with a captured email dropped,
    // found by an audit that went looking, while the connection itself
    // reported `runtime_status: healthy` throughout.
    //
    // A count and nothing else. The admin listing carrying the same rows
    // returns connection identifiers spanning every space, and this
    // endpoint is unauthenticated; a count is the shape it already
    // publishes for the connection ceiling below.
    //
    // It degrades the response deliberately, because the external poller
    // keys on `status` being `ok` and that is the whole mechanism: no new
    // credential, no new schedule, no second notifier. `/health` stays 200
    // when degraded, so the container's own liveness probe is unaffected.
    //
    // The evidence expires: pg-boss deletes a failed row seven days after
    // it fails, so an untouched alert eventually resolves itself. That is
    // not a reason to stay silent — the row goes at seven days whether or
    // not anyone was told — but it is why the alert wants acting on rather
    // than filing.
    if (countDeadLetters) {
      const cached = deadLettersCache;
      let count: number | undefined;
      if (cached && performance.now() - cached.at < CONNECTIONS_CACHE_MS) {
        count = cached.value;
      } else {
        try {
          const outcome = await withBudget(countDeadLetters());
          if (outcome !== TIMED_OUT) {
            count = outcome;
            deadLettersCache = { at: performance.now(), value: outcome };
          }
        } catch {
          // Omitted rather than guessed, matching the connection figures
          // below: the database component above has already reported
          // whatever stopped this from answering, and a zero here would
          // read as "nothing has failed".
        }
      }
      if (count !== undefined) {
        components.dead_letters = {
          status: count === 0 ? "ok" : "degraded",
          count,
        };
        if (count > 0) overall = "degraded";
      }
    }

    // Shipped types this instance still carries that the build no longer
    // names. Derived at boot from the build and the rows, so reading it
    // costs nothing and cannot go stale against a running process.
    //
    // A count and nothing else, for the reason the dead-letter component
    // gives: this endpoint is unauthenticated, and the identifiers say
    // which types an instance is serving that its build does not. Those
    // sit behind the admin read.
    //
    // Not a component: it carries no status and never degrades the
    // response, which is the shape the connection figures below take.
    // Neither kind of drift is a fault. A retired type that still holds
    // items is the designed outcome, because the row is what makes those
    // items resolve, and the removal route refuses to drop it. A retired
    // type holding nothing is untidy rather than unhealthy: it resolves,
    // it serves, it costs nothing. Overall status answers whether this
    // instance is serving correctly right now, and a row that changes no
    // behavior is not part of that answer.
    //
    // It degraded the response first, which paged unattended alerting for
    // housekeeping no operator could always clear, and a component that
    // can sit degraded indefinitely teaches its readers to ignore the ones
    // that matter. The rule that replaces it: a check earns the right to
    // degrade only if something is wrong now. If the honest description is
    // "someone could tidy this up", it is a report.
    const platformTypes = { drifted: platformDrift().length };

    // How many rows this instance holds whose stored value falls outside
    // the union the build compares that column against. Counted at boot,
    // so reading it costs nothing and cannot go stale against a running
    // process.
    //
    // A count and nothing else, and here that is sharper than it is for
    // the drift figure above: this endpoint is unauthenticated, and the
    // value itself would advertise the shape of a partially-applied
    // migration to anyone who asks. The true stored string is on the boot
    // log, behind the operator's access to it.
    //
    // Not a component, and this is the shape decision rather than the
    // field. It carries no status and never moves `overall`, which is
    // `platform_types`'s shape and deliberately not `dead_letters`'s. The
    // rule is already written into this file: a check earns the right to
    // degrade only if something is wrong now. This one can sit non-zero
    // indefinitely — clearing it needs a migration or a hand `UPDATE` on
    // somebody's schedule, not a button — and a component that can sit
    // degraded indefinitely teaches its readers to ignore the ones that
    // matter. The severity lives on the boot log, which is `error`-level
    // and names the table, the column, the true stored string and the
    // count.
    //
    // Rows rather than distinct values: "how many rows" is the question
    // the motivating incident left unanswered, and it is what tells one
    // restored row from a whole table.
    //
    // `scanned` is here because zero rows has three meanings and this is
    // one number over all of them: nothing recorded yet, nothing found,
    // and looked-but-could-not-read. The third is reachable and is the
    // scenario the whole feature exists for — a newer image meeting a
    // database whose migration has not landed raises `42703`, the scan's
    // catch fires, and without this field the endpoint would serve exactly
    // what a healthy instance serves. It carries no identifier, so it does
    // not touch the reason the values themselves stay off an
    // unauthenticated endpoint.
    //
    // It still never moves `overall`. A scan that could not run is not the
    // instance failing to serve, and the rule this block already follows
    // says a check earns the right to degrade only if something is wrong
    // now.
    const scan = storedValueScan();
    const storedValues = {
      rows: scan.values.reduce((sum, v) => sum + v.count, 0),
      scanned: scan.scanned,
    };

    const version = await readVersion();
    const placement = readPlacement();

    return c.json({
      status: overall,
      auth_mode: config.authMode,
      components,
      platform_types: platformTypes,
      unrecognized_stored_values: storedValues,
      ...(databaseConnections && {
        database_connections: databaseConnections,
      }),
      ...(placement && { placement }),
      ...(version && { version }),
    });
  });

  return router;
}
