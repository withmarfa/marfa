import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { platformDrift } from "../storage/platform-drift.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import type { AppConfig } from "../config.js";
import type { MarfaAuth } from "../auth/instance.js";
import type { OidcProviderHealth } from "../auth/oidc-availability.js";
import type { PgClient } from "../storage/pg/connection.js";

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
   *  (`marfa-web:app`, `marfa-worker:lock`); anything else is `other`. */
  clients: Record<string, Record<string, number>>;
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
const PROBE_TIMEOUT_MS = 2_000;

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
/** The `application_name` shape `createConnection` sets: an optional role
 *  suffix on the base label, then the pool that opened the connection. */
const MARFA_CLIENT = /^marfa(-[a-z]+)?:(app|session|lock)$/;

async function readDatabaseConnections(
  client: PgClient,
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
  return {
    total,
    ceiling: Math.max(0, maxConnections - reserved),
    max_connections: maxConnections,
    reserved,
    clients,
  };
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

    // Database. `down` and `degraded` are different answers and the
    // difference is the useful part: `down` means the database refused,
    // `degraded` means we could not get an answer inside the budget, which
    // is what pool exhaustion looks like from here.
    const dbStart = performance.now();
    try {
      const outcome = await withBudget(storage.keys.count());
      components.database =
        outcome === TIMED_OUT
          ? {
              status: "degraded",
              error: `no answer within ${String(PROBE_TIMEOUT_MS)}ms — the connection pool may be fully held`,
            }
          : {
              status: "ok",
              latency_ms: Math.round(performance.now() - dbStart),
            };
    } catch (err) {
      components.database = {
        status: "down",
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

    // How much of the connection ceiling this deployment is holding. Not a
    // component: it carries no status and never degrades the response. Pool
    // exhaustion has taken this deployment down twice and nothing published
    // the number that would have shown either coming — the provider offers
    // no connection-count metric at all, so the server that owns the pools
    // is the only thing that can say.
    let databaseConnections: DatabaseConnections | undefined;
    if (pgClient) {
      const cached = connectionsCache;
      if (cached && performance.now() - cached.at < CONNECTIONS_CACHE_MS) {
        databaseConnections = cached.value;
      } else {
        try {
          const outcome = await withBudget(readDatabaseConnections(pgClient));
          if (outcome !== TIMED_OUT) {
            databaseConnections = outcome;
            connectionsCache = { at: performance.now(), value: outcome };
          }
        } catch {
          // Omitted rather than guessed. The database component above has
          // already reported whatever stopped this from answering.
        }
      }
    }

    const version = await readVersion();
    const placement = readPlacement();

    return c.json({
      status: overall,
      auth_mode: config.authMode,
      components,
      platform_types: platformTypes,
      ...(databaseConnections && {
        database_connections: databaseConnections,
      }),
      ...(placement && { placement }),
      ...(version && { version }),
    });
  });

  return router;
}
