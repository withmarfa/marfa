import { afterEach, describe, expect, it, vi } from "vitest";
import {
  healthRoutes,
  CONNECTIONS_CACHE_MS,
  PROBE_TIMEOUT_MS,
} from "./health.js";
import { setStoredValueScan } from "../storage/stored-value-scan.js";
import type { AppConfig } from "../config.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";

/**
 * What "answered rather than hung" is allowed to cost.
 *
 * Derived from the endpoint's own probe budget rather than picked. Both
 * regressions this guards are unbounded waits — the production incident was
 * fifty-two seconds and then a 500 — so the bound does not need to be tight,
 * it needs to be far below unbounded and comfortably above one probe budget
 * on a machine that is sometimes busy. Three times the budget is both.
 *
 * A bare figure here would measure the runner instead: too low and a loaded
 * machine reports a defect that is not there, too high and it stops meaning
 * anything. Written against the constant so that changing the probe budget
 * moves this with it.
 */
const ANSWERS_WITHIN_MS = PROBE_TIMEOUT_MS * 3;

/**
 * `/health` had no test at all until the endpoint stopped answering on
 * production. It could not answer because both of its probes were
 * unbounded: the database probe queues for a pool slot, and postgres.js
 * queues an unavailable reservation forever, so a fully-held pool turned
 * the liveness endpoint into the one surface that could say nothing while
 * ordinary requests were still being served.
 *
 * These use fakes rather than a database on purpose — the property under
 * test is what the endpoint does when a probe does not come back, and a
 * real database is the wrong instrument for producing that.
 */

const never = new Promise<never>(() => {
  // Deliberately never settles: this is the pool-exhaustion shape.
});

function buildStorage(count: () => Promise<number>): Storage {
  return { keys: { count } } as unknown as Storage;
}

function buildBlobs(exists: () => Promise<boolean>): BlobBackend {
  return { exists } as unknown as BlobBackend;
}

const config = { authMode: "keys" } as AppConfig;

interface HealthBody {
  status: string;
  components: {
    database?: { status: string; error?: string };
    blob_storage?: { status: string; error?: string };
  };
  placement?: { region?: string; location?: string; country?: string };
  database_connections?: unknown;
}

interface StoredValueBody extends HealthBody {
  unrecognized_stored_values?: { rows: number; scanned: boolean };
}

interface DeadLetterBody extends HealthBody {
  components: HealthBody["components"] & {
    dead_letters?: { status: string; count?: number };
  };
}

describe("GET /health", () => {
  it("reports ok when both probes answer", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.components.database?.status).toBe("ok");
    expect(body.components.blob_storage?.status).toBe("ok");
  });

  // The reading comes from `pg_stat_activity`, so there is nothing to read
  // on a dialect that has neither a pool nor that view. Absent is the honest
  // answer; a zeroed block would read as a deployment holding no
  // connections, which is a different and wrong claim.
  it("omits the connection reading on a storage with no pool", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const body = (await (await app.request("/")).json()) as HealthBody;
    expect(body.database_connections).toBeUndefined();
  });

  // A dispatch that exhausted its retries announced itself nowhere. One sat
  // in a live space for thirty-three hours with a captured email dropped,
  // while the connection reported healthy throughout. The external poller
  // keys on `status` being `ok`, so degrading here is the whole mechanism.
  it("degrades on a dead letter, and says how many without saying whose", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
      undefined,
      () => Promise.resolve(2),
    );

    const res = await app.request("/");
    // Still 200: the container's own liveness probe reads the code, and a
    // degraded build that is serving is still the build that is serving.
    expect(res.status).toBe(200);

    const body = (await res.json()) as DeadLetterBody;
    expect(body.status).toBe("degraded");
    expect(body.components.dead_letters).toEqual({
      status: "degraded",
      count: 2,
    });
  });

  it("stays ok when nothing has given up", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
      undefined,
      () => Promise.resolve(0),
    );

    const body = (await (await app.request("/")).json()) as DeadLetterBody;
    expect(body.status).toBe("ok");
    expect(body.components.dead_letters).toEqual({ status: "ok", count: 0 });
  });

  // Absent rather than zero. A deployment with no local substrate has no
  // dispatch queue, and reporting zero would claim nothing has failed on a
  // queue that does not exist.
  it("omits the component when this deployment runs no substrate", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const body = (await (await app.request("/")).json()) as DeadLetterBody;
    expect(body.components.dead_letters).toBeUndefined();
    expect(body.status).toBe("ok");
  });

  // Same rule as the connection figures: a probe that cannot answer is
  // omitted rather than guessed, because a zero here reads as "nothing has
  // failed" and that is the one wrong answer.
  //
  // And it swallows the reason, which the database and blob components
  // deliberately do not: both put the thrown message on the response. A
  // failing query over `pgboss.job` can carry the queue name, a job id or
  // whatever the driver decided to quote, and this endpoint is
  // unauthenticated. The error text below is what such a message looks
  // like, and none of it may reach the body.
  it("omits the component, and its reason, when the count throws", async () => {
    const leaky = new Error(
      'relation "pgboss.job" line 1: name = marfa.integrations.local, ' +
        "connection_id 01a01ef6-fb73-7c70-8cce-4dc9d02ff14d",
    );
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
      undefined,
      () => Promise.reject(leaky),
    );

    const res = await app.request("/");
    const raw = await res.text();
    expect(
      (JSON.parse(raw) as DeadLetterBody).components.dead_letters,
    ).toBeUndefined();
    expect(raw).not.toContain("connection_id");
    expect(raw).not.toContain("pgboss");
    expect(raw).not.toContain("01a01ef6");
  });

  it("omits the component rather than hanging when the count never returns", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
      undefined,
      () => never,
    );

    const started = Date.now();
    const body = (await (await app.request("/")).json()) as DeadLetterBody;
    expect(Date.now() - started).toBeLessThan(ANSWERS_WITHIN_MS);
    expect(body.components.dead_letters).toBeUndefined();
    expect(body.components.database?.status).toBe("ok");
  });

  it("answers degraded instead of hanging when the database probe never returns", async () => {
    const app = healthRoutes(
      buildStorage(() => never),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const started = Date.now();
    const res = await app.request("/");
    const elapsed = Date.now() - started;

    // Answering at all is the point. The status code stays 200 because
    // the deploy gate reads the body, and a degraded build that is
    // serving is still the build that is serving.
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(ANSWERS_WITHIN_MS);

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.components.database?.status).toBe("degraded");
    expect(body.components.database?.error).toContain("pool");
  }, 15_000);

  it("answers degraded instead of hanging when blob storage never returns", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => never),
      config,
    );

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.components.blob_storage?.status).toBe("degraded");
    // The database still answered, and the endpoint still says so.
    expect(body.components.database?.status).toBe("ok");
  }, 15_000);

  it("separates a refusal from a timeout", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.reject(new Error("connection refused"))),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const res = await app.request("/");
    const body = (await res.json()) as HealthBody;
    // `down` means the database answered with a refusal; `degraded` means
    // no answer arrived. Collapsing them would lose the distinction that
    // tells an operator whether to look at the database or at the pool.
    expect(body.components.database?.status).toBe("down");
    expect(body.components.database?.error).toContain("connection refused");
  });
});

/**
 * Placement is reported so that something outside the platform can assert it.
 * A container scheduled a continent away from its database raises no error,
 * fails no deploy and degrades no status — it only costs latency, which then
 * gets blamed on whichever component the payload does name. Production ran
 * that way for four months behind a green pipeline.
 */
describe("GET /health placement", () => {
  const withEnv = async (
    vars: Record<string, string | undefined>,
    run: () => Promise<void>,
  ) => {
    const saved = { ...process.env };
    Object.assign(process.env, vars);
    try {
      await run();
    } finally {
      process.env = saved;
    }
  };

  const build = () =>
    healthRoutes(
      buildStorage(() => Promise.resolve(1)),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

  it("reports what the deployment states about itself", async () => {
    await withEnv(
      {
        MARFA_PLACEMENT_REGION: "lon1",
        MARFA_PLACEMENT_LOCATION: "London",
        MARFA_PLACEMENT_COUNTRY: "GB",
      },
      async () => {
        const body = (await (await build().request("/")).json()) as HealthBody;
        expect(body.placement).toEqual({
          region: "lon1",
          location: "London",
          country: "GB",
        });
      },
    );
  });

  // Nothing sets these unless an operator does. A deployment that has not
  // been told where it is has to be able to say nothing rather than say an
  // empty string, because a caller reading "" as a region would compare it
  // against the expected one and fail a deploy that is fine.
  it("omits the block entirely when nothing is configured", async () => {
    await withEnv(
      {
        MARFA_PLACEMENT_REGION: undefined,
        MARFA_PLACEMENT_LOCATION: undefined,
        MARFA_PLACEMENT_COUNTRY: undefined,
      },
      async () => {
        const body = (await (await build().request("/")).json()) as HealthBody;
        expect(body.placement).toBeUndefined();
      },
    );
  });

  it("reports a partial placement rather than dropping it", async () => {
    await withEnv(
      {
        MARFA_PLACEMENT_REGION: "lon1",
        MARFA_PLACEMENT_LOCATION: undefined,
        MARFA_PLACEMENT_COUNTRY: undefined,
      },
      async () => {
        const body = (await (await build().request("/")).json()) as HealthBody;
        expect(body.placement).toEqual({ region: "lon1" });
      },
    );
  });
});

describe("GET /health unrecognized stored values", () => {
  // Module state, exactly as `platformDrift` is, so one case would
  // otherwise decide the next one's answer.
  afterEach(() => {
    setStoredValueScan({ scanned: false, values: [] });
  });

  function build(): ReturnType<typeof healthRoutes> {
    return healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );
  }

  async function body(): Promise<StoredValueBody> {
    return (await (await build().request("/")).json()) as StoredValueBody;
  }

  it("reports zero, and says it has not looked, before any boot has", async () => {
    expect((await body()).unrecognized_stored_values).toEqual({
      rows: 0,
      scanned: false,
    });
  });

  it("counts rows across every column rather than distinct values", async () => {
    // "How many rows" is the question the motivating incident left
    // unanswered, and the number is what tells one restored row from a
    // whole table.
    setStoredValueScan({
      scanned: true,
      values: [
        { table: "users", column: "role", value: "owner", count: 40 },
        { table: "items", column: "state", value: "quarantined", count: 2 },
      ],
    });

    expect((await body()).unrecognized_stored_values).toEqual({
      rows: 42,
      scanned: true,
    });
  });

  it("distinguishes a scan that failed from one that found nothing", async () => {
    // The reachable scenario this field exists for: a newer image meets a
    // database whose migration has not landed, Postgres raises `42703` on
    // the missing column, the scan's catch fires and records nothing. With
    // the count alone, the endpoint served exactly what a healthy instance
    // serves — and the commit that argues a log line is not a signal would
    // have put the failure signal for the reporting mechanism back on the
    // log.
    setStoredValueScan({ scanned: true, values: [] });
    const clean = (await body()).unrecognized_stored_values;

    setStoredValueScan({ scanned: false, values: [] });
    const failed = (await body()).unrecognized_stored_values;

    expect(clean).toEqual({ rows: 0, scanned: true });
    expect(failed).toEqual({ rows: 0, scanned: false });
    expect(failed).not.toEqual(clean);
  });

  it("stays ok while the count is non-zero", async () => {
    // The shape decision, not the field. This copies `platform_types` and
    // deliberately not `dead_letters`: a check earns the right to degrade
    // only if something is wrong now, and this one can sit non-zero
    // indefinitely because clearing it needs a migration or a hand
    // `UPDATE` on somebody's schedule rather than a button. A component
    // that can sit degraded forever teaches its readers to ignore the ones
    // that matter. The severity lives on the boot log instead.
    setStoredValueScan({
      scanned: true,
      values: [{ table: "users", column: "role", value: "owner", count: 40 }],
    });

    const res = await build().request("/");
    const parsed = (await res.json()) as StoredValueBody;

    expect(res.status).toBe(200);
    expect(parsed.status).toBe("ok");
    expect(parsed.unrecognized_stored_values).toEqual({
      rows: 40,
      scanned: true,
    });
  });

  it("stays ok when the scan itself could not run", async () => {
    // A scan that could not read is not the instance failing to serve.
    setStoredValueScan({ scanned: false, values: [] });

    const res = await build().request("/");
    expect(res.status).toBe(200);
    expect(((await res.json()) as StoredValueBody).status).toBe("ok");
  });

  it("carries the number and not the values", async () => {
    // `/health` is unauthenticated, and the value itself would advertise
    // the shape of a partially-applied migration to anyone who asks. The
    // `scanned` flag is a boolean and carries no identifier, so it does
    // not weaken this.
    setStoredValueScan({
      scanned: true,
      values: [
        { table: "users", column: "role", value: "tenant_admin", count: 40 },
      ],
    });

    const text = await (await build().request("/")).text();
    expect(text).not.toContain("tenant_admin");
    expect(text).not.toContain("users");
  });
});

/**
 * What `/health` reports about this process's own connection pool.
 *
 * Fakes rather than a database, and for a sharper reason than the blocks
 * above: the property under test is what the endpoint makes of a set of rows
 * from `pg_stat_activity`, so the rows are the input. Driving a real pool to
 * its limit would test the pool, take a shared machine's Postgres with it,
 * and still assert nothing beyond the numbers written directly below.
 *
 * Every case here is a reading. None of them is a verdict, because the
 * endpoint does not draw one — which the first test in this block pins
 * directly rather than leaving to the absence of an assertion.
 */
interface ActivityRow {
  client: string;
  state: string;
  connections: number;
  /** How many of `connections` are the backend taking this reading. */
  self: number;
  max_connections: number;
  reserved: number;
}

interface PoolBody {
  status: string;
  components: {
    database?: { status: string; latency_ms?: number; error?: string };
    blob_storage?: { status: string; latency_ms?: number; error?: string };
  };
  database_connections?: {
    total: number;
    clients: Record<string, Record<string, number>>;
    pool?: {
      size: number;
      in_use: number;
      idle_in_transaction: number;
      free: number;
    };
  };
}

/**
 * A storage whose `pgClient` answers the `pg_stat_activity` query from a
 * mutable holder, so a test can change what the database says between two
 * requests. `readDatabaseConnections` calls the client as a tagged template
 * and reads the result as rows, so a function returning them is all it needs.
 */
function buildPooledStorage(rows: { current: ActivityRow[] }): Storage {
  return {
    keys: { count: () => Promise.resolve(3) },
    pgClient: () => Promise.resolve(rows.current),
  } as unknown as Storage;
}

/**
 * The production web container's setting. Every number below is only
 * meaningful against a pool size, and this is the one the deployment runs —
 * which is also why the distance between a roomy pool and a full one is a
 * couple of requests rather than a percentage.
 */
const WEB_POOL_SIZE = 3;

/** No `processRole`, so the pools label themselves `marfa-both`. */
const pooledConfig = {
  authMode: "keys",
  dbPoolSize: WEB_POOL_SIZE,
} as AppConfig;

const APP_POOL = "marfa-both:app";

/**
 * This process's pool in the given backend states, on a managed tier's shape:
 * 25 advertised, 3 held back for superusers. `self` counts the reading's own
 * backend within a state, and defaults to none so a test says when it is
 * modelling the observer.
 */
function activity(
  states: Record<string, number>,
  self: Record<string, number> = {},
): ActivityRow[] {
  return Object.entries(states).map(([state, connections]) => ({
    client: APP_POOL,
    state,
    connections,
    self: self[state] ?? 0,
    max_connections: 25,
    reserved: 3,
  }));
}

function pooledApp(
  rows: { current: ActivityRow[] },
  appConfig: AppConfig = pooledConfig,
) {
  return healthRoutes(
    buildPooledStorage(rows),
    buildBlobs(() => Promise.resolve(false)),
    appConfig,
  );
}

function pooled(states: Record<string, number>, self?: Record<string, number>) {
  return pooledApp({ current: activity(states, self) });
}

/**
 * Read `/health` twice with the connection cache expired in between, so the
 * second read takes a fresh reading rather than being served the first.
 *
 * The clock is a stub on `performance.now` rather than vitest's fake timers.
 * Faking timers wholesale also replaces `withBudget`'s `setTimeout`, and
 * faking only `performance` made `performance.now()` return something the
 * subtraction turned into `NaN` — which serializes to `null`, so every
 * latency assertion failed reporting a type rather than the thing under
 * test. A stub returning a number this function controls has neither
 * problem, and the elapsed figures it produces are zero rather than
 * arbitrary.
 */
async function readTwice(
  app: ReturnType<typeof pooledApp>,
  between?: () => void,
): Promise<PoolBody> {
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    await app.request("/");
    between?.();
    clock += CONNECTIONS_CACHE_MS + 1;
    return (await (await app.request("/")).json()) as PoolBody;
  } finally {
    now.mockRestore();
  }
}

describe("GET /health pool occupancy", () => {
  /**
   * The load-bearing property of this whole block: occupancy is published,
   * never judged. `components.database` means what it meant before this
   * reading existed — the probe missed its budget, or the database refused —
   * and the external status page keys on it.
   *
   * Every shape here is a pool with nothing left to hand out, and the four
   * straddle the removed verdict's own guard: three sat at `in_use === size`,
   * which it judged and degraded on, and the fourth exceeds the size, which
   * it refused. Each is read twice with the cache expired between, so a
   * decision needing successive readings to agree would have had both. `free`
   * is asserted alongside the status so the case cannot pass by never
   * reaching exhaustion at all, which is how this test would rot into one
   * that proves nothing.
   *
   * Reconnecting occupancy to the status reddens this and nothing else.
   */
  it.each([
    ["every slot running a query", { active: 3 }, 0],
    ["every slot held by an open transaction", { "idle in transaction": 3 }, 3],
    [
      "a mix of both, with none free",
      { active: 2, "idle in transaction": 1 },
      1,
    ],
    ["more in use than one pool can hold", { active: 5 }, 0],
  ])(
    "stays ok with %s",
    async (
      _name,
      states: Record<string, number>,
      heldInTransaction: number,
    ) => {
      const body = await readTwice(pooledApp({ current: activity(states) }));

      expect(body.database_connections?.pool?.free).toBe(0);
      expect(body.database_connections?.pool?.idle_in_transaction).toBe(
        heldInTransaction,
      );
      expect(body.components.database?.status).toBe("ok");
      expect(body.status).toBe("ok");
    },
  );

  /**
   * The other way occupancy could reach `components.database`, and the one a
   * verdict's removal does not close on its own.
   *
   * Both the connections read and the database probe run on the app pool, and
   * a probe that loses its budget is not cancelled — `withBudget` says so; it
   * stays queued for a slot. Read first, the connections query can therefore
   * leave a backend queued that the database probe then waits behind, and the
   * probe degrades because of something this endpoint was still holding. That
   * is pool occupancy moving the status by contention rather than by verdict:
   * the same wrong answer, reached quietly.
   *
   * The fakes here cannot contend — they are independent promises — so what
   * is pinned is the ordering that makes contention unconstructible. An
   * earlier revision of this branch hoisted the read above the probe so a
   * verdict could consult the figures; this reddens if that comes back.
   */
  it("probes the database before reading the pool they share", async () => {
    const calls: string[] = [];
    const storage = {
      keys: {
        count: () => {
          calls.push("probe");
          return Promise.resolve(3);
        },
      },
      pgClient: () => {
        calls.push("connections");
        return Promise.resolve(activity({ idle: 1 }));
      },
    } as unknown as Storage;

    const body = (await (
      await healthRoutes(
        storage,
        buildBlobs(() => Promise.resolve(false)),
        pooledConfig,
      ).request("/")
    ).json()) as PoolBody;

    expect(calls).toEqual(["probe", "connections"]);
    // Both still happened: an ordering assertion that passed because one of
    // them never ran would prove nothing.
    expect(body.components.database?.status).toBe("ok");
    expect(body.database_connections?.pool).toBeDefined();
  });

  it("reports how much of the pool is held, not only whether it answered", async () => {
    const body = (await (
      await pooled({ active: 1, idle: 2 }).request("/")
    ).json()) as PoolBody;

    // The climb this endpoint published nothing about before. Two idle
    // connections are in the pool and free; one is running a query.
    expect(body.database_connections?.pool).toEqual({
      size: WEB_POOL_SIZE,
      in_use: 1,
      idle_in_transaction: 0,
      free: 2,
    });
    expect(body.components.database?.status).toBe("ok");
  });

  // The reading runs on the app pool, so at the moment `pg_stat_activity` is
  // sampled the connection taking it is `active` in this very bucket.
  // Counting it adds a constant one to every reading a process takes of
  // itself, which is the instrument's own weight rather than occupancy — a
  // third of the range on a pool of three.
  it("leaves its own backend out of the pool it is measuring", async () => {
    const body = (await (
      await pooled({ active: 2, idle: 1 }, { active: 1 }).request("/")
    ).json()) as PoolBody;

    // One of the two active backends is the observer.
    expect(body.database_connections?.pool?.in_use).toBe(1);
    expect(body.database_connections?.pool?.free).toBe(2);
    // And it is still in the database-wide figures, which describe the
    // database as it is rather than as this process would like it.
    expect(body.database_connections?.total).toBe(3);
    expect(body.database_connections?.clients[APP_POOL]).toEqual({
      active: 2,
      idle: 1,
    });
  });

  // A NULL `state` is a permissions verdict, not a state: PostgreSQL hands a
  // non-superuser `application_name` for every backend but blanks `state` for
  // roles it has no privileges of. This pool's own connections are opened as
  // this role, so a masked row wearing this label belongs to somebody else,
  // and counting it would report another role's traffic as this pool filling.
  it("excludes a backend whose state it was not allowed to read", async () => {
    const body = (await (
      await pooled({ active: 1, idle: 1, unknown: 4 }).request("/")
    ).json()) as PoolBody;

    expect(body.database_connections?.pool).toEqual({
      size: WEB_POOL_SIZE,
      in_use: 1,
      idle_in_transaction: 0,
      free: 2,
    });
    // Still counted in the database-wide figures, which describe every
    // connection racing the ceiling whoever can read its state.
    expect(body.database_connections?.total).toBe(6);
    expect(body.database_connections?.clients[APP_POOL]?.unknown).toBe(4);
  });

  // Startup. The pools open lazily, so before the first query there is no row
  // for this bucket at all — and the honest reading of that is an empty pool,
  // not a missing one.
  it("reports an untouched pool as wholly free", async () => {
    const body = (await (await pooled({}).request("/")).json()) as PoolBody;

    expect(body.database_connections?.pool).toEqual({
      size: WEB_POOL_SIZE,
      in_use: 0,
      idle_in_transaction: 0,
      free: WEB_POOL_SIZE,
    });
    expect(body.components.database?.status).toBe("ok");
  });

  // The fail-open this guard exists for. A label the bucketing does not
  // recognize folds into `other`, so the tally finds nothing under this
  // process's own name and would otherwise publish a confident `in_use: 0` —
  // indistinguishable from a genuinely idle pool. Absent says so instead.
  it("omits the pool rather than reporting zero when the label is unattributable", async () => {
    const body = (await (
      await pooledApp({ current: activity({ active: 3 }) }, {
        authMode: "keys",
        dbPoolSize: WEB_POOL_SIZE,
        processRole: "sidecar",
      } as unknown as AppConfig).request("/")
    ).json()) as PoolBody;

    expect(body.database_connections).toBeDefined();
    expect(body.database_connections?.pool).toBeUndefined();
    // The database-wide figures are unaffected: they do not depend on
    // recognizing this process's own label.
    expect(body.database_connections?.total).toBe(3);
    expect(body.components.database?.status).toBe("ok");
  });

  // A slot the pool has not opened is a free slot. The pools open lazily, so
  // counting sockets rather than states would read an idle deployment as
  // having no capacity at all.
  it("counts an unopened slot as free", async () => {
    const body = (await (
      await pooled({ active: 1 }).request("/")
    ).json()) as PoolBody;

    expect(body.database_connections?.pool).toEqual({
      size: WEB_POOL_SIZE,
      in_use: 1,
      idle_in_transaction: 0,
      free: 2,
    });
  });

  // `idle in transaction (aborted)` is the same connection in the same
  // predicament, and matching the exact string would have missed it.
  it("counts an aborted transaction's connection as held", async () => {
    const body = (await (
      await pooled({
        "idle in transaction": 1,
        "idle in transaction (aborted)": 2,
      }).request("/")
    ).json()) as PoolBody;

    expect(body.database_connections?.pool?.idle_in_transaction).toBe(3);
    expect(body.database_connections?.pool?.in_use).toBe(3);
  });

  // `application_name` carries the process role, so two replicas of one role
  // land in one bucket while `size` stays a single process's own max. The
  // figure is then a role's occupancy rather than a process's, which is a
  // caveat on how to read it — but a negative slot count would be arithmetic
  // nobody intended, so it floors.
  it("floors free at zero when the tally exceeds one pool's size", async () => {
    const body = (await (
      await pooled({ active: 5 }).request("/")
    ).json()) as PoolBody;

    expect(body.database_connections?.pool?.in_use).toBe(5);
    expect(body.database_connections?.pool?.free).toBe(0);
  });

  // The cache is what keeps a health check from taking a pool slot in order
  // to measure pool slots, and the figures going stale inside the window is
  // the price rather than a defect. Here the clock does not move, so the
  // second request is answered from the first reading.
  it("serves the figures from cache within the window", async () => {
    const rows = { current: activity({ active: 1, "idle in transaction": 2 }) };
    const app = pooledApp(rows);

    const now = vi.spyOn(performance, "now").mockImplementation(() => 0);
    try {
      await app.request("/");
      rows.current = activity({ idle: 3 });
      const body = (await (await app.request("/")).json()) as PoolBody;

      expect(body.database_connections?.pool?.free).toBe(0);
      expect(body.components.database?.status).toBe("ok");
    } finally {
      now.mockRestore();
    }
  });

  // And once the window expires the figures catch up, which is the half that
  // makes the staleness above bounded rather than permanent.
  it("takes a fresh reading once the cache expires", async () => {
    const rows = { current: activity({ active: 1, "idle in transaction": 2 }) };
    const body = await readTwice(pooledApp(rows), () => {
      rows.current = activity({ idle: 3 });
    });

    expect(body.database_connections?.pool).toEqual({
      size: WEB_POOL_SIZE,
      in_use: 0,
      idle_in_transaction: 0,
      free: WEB_POOL_SIZE,
    });
  });

  // A probe that failed after most of its budget and one that failed at once
  // are different faults, and the branch that said nothing was the one where
  // the number said most. Both bounded probes, because the argument is the
  // same for each.
  it("reports probe latency on every branch of both bounded probes", async () => {
    const dbDown = healthRoutes(
      buildStorage(() => Promise.reject(new Error("connection refused"))),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );
    const blobDown = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.reject(new Error("bucket unreachable"))),
      config,
    );
    const bothStalled = healthRoutes(
      buildStorage(() => never),
      buildBlobs(() => never),
      config,
    );

    const a = (await (await dbDown.request("/")).json()) as PoolBody;
    const b = (await (await blobDown.request("/")).json()) as PoolBody;
    const c = (await (await bothStalled.request("/")).json()) as PoolBody;

    expect(a.components.database?.status).toBe("down");
    expect(typeof a.components.database?.latency_ms).toBe("number");

    expect(b.components.blob_storage?.status).toBe("down");
    expect(typeof b.components.blob_storage?.latency_ms).toBe("number");

    // Asserted as numbers rather than against durations. What is pinned is
    // that the field is there; a bound on the value would be measuring the
    // machine this runs on.
    expect(c.components.database?.status).toBe("degraded");
    expect(typeof c.components.database?.latency_ms).toBe("number");
    expect(c.components.blob_storage?.status).toBe("degraded");
    expect(typeof c.components.blob_storage?.latency_ms).toBe("number");
  }, 15_000);
});
