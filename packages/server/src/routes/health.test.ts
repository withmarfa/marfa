import { afterEach, describe, expect, it } from "vitest";
import { healthRoutes, PROBE_TIMEOUT_MS } from "./health.js";
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
 * The database component's verdict on pool occupancy.
 *
 * Fakes rather than a database, and for a sharper reason than the blocks
 * above: the property under test is what the endpoint concludes from a set
 * of figures, so the figures are the input. Driving a real pool to its limit
 * would test the pool, take a shared machine's Postgres with it, and still
 * assert nothing beyond the numbers written directly below.
 */
interface ActivityRow {
  client: string;
  state: string;
  connections: number;
  max_connections: number;
  reserved: number;
}

interface PoolBody {
  status: string;
  components: {
    database?: { status: string; latency_ms?: number; error?: string };
  };
  database_connections?: {
    pool: {
      size: number;
      in_use: number;
      idle_in_transaction: number;
      free: number;
    };
  };
}

/**
 * A storage whose `pgClient` answers the `pg_stat_activity` query with the
 * given rows. `readDatabaseConnections` calls the client as a tagged
 * template and reads the result as rows, so a function returning them is the
 * whole of what it needs.
 */
function buildPooledStorage(rows: ActivityRow[]): Storage {
  return {
    keys: { count: () => Promise.resolve(3) },
    pgClient: () => Promise.resolve(rows),
  } as unknown as Storage;
}

/**
 * The production web container's setting. Every number below is only
 * meaningful against a pool size, and this is the one the deployment runs —
 * which is also why the distance between healthy and unusable is a couple of
 * requests rather than a percentage.
 */
const WEB_POOL_SIZE = 3;

/** No `processRole`, so the pools label themselves `marfa-both`. */
const pooledConfig = {
  authMode: "keys",
  dbPoolSize: WEB_POOL_SIZE,
} as AppConfig;

const APP_POOL = "marfa-both:app";

/**
 * This process's own pool in the given backend states, on a managed tier's
 * shape: 25 advertised, 3 held back for superusers.
 */
function activity(states: Record<string, number>): ActivityRow[] {
  return Object.entries(states).map(([state, connections]) => ({
    client: APP_POOL,
    state,
    connections,
    max_connections: 25,
    reserved: 3,
  }));
}

function pooled(states: Record<string, number>) {
  return healthRoutes(
    buildPooledStorage(activity(states)),
    buildBlobs(() => Promise.resolve(false)),
    pooledConfig,
  );
}

describe("GET /health pool occupancy", () => {
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

  // The regression the verdict exists for. Before it this response was
  // byte-for-byte the healthy one: the probe answers either way, so a pool
  // with nothing left reported exactly what an idle pool reported.
  it("degrades on a fully held pool while the probe still answers", async () => {
    const res = await pooled({
      active: 1,
      "idle in transaction": 2,
    }).request("/");

    // Still 200. The container's own liveness probe reads the code, and a
    // degraded deployment that is serving is still serving.
    expect(res.status).toBe(200);

    const body = (await res.json()) as PoolBody;
    expect(body.status).toBe("degraded");
    expect(body.components.database?.status).toBe("degraded");
    // The probe itself was fine, which is the whole point of the verdict.
    expect(typeof body.components.database?.latency_ms).toBe("number");
    // And it says which kind of full: held by open transactions rather than
    // busy with queries, which is the difference between wedged and loaded.
    expect(body.components.database?.error).toContain("all 3");
    expect(body.components.database?.error).toContain("2 of them");
    expect(body.database_connections?.pool.free).toBe(0);
  });

  // Busy is not wedged. Every slot doing work and one still free is the
  // ordinary shape of a loaded server, and a component that degraded here
  // would be one an operator learns to ignore.
  it("stays ok while any slot is free, however busy the rest are", async () => {
    const body = (await (
      await pooled({ active: 2, idle: 1 }).request("/")
    ).json()) as PoolBody;

    expect(body.components.database?.status).toBe("ok");
    expect(body.status).toBe("ok");
    expect(body.database_connections?.pool.free).toBe(1);
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
    expect(body.components.database?.status).toBe("ok");
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

    expect(body.database_connections?.pool.idle_in_transaction).toBe(3);
    expect(body.components.database?.status).toBe("degraded");
  });

  // Another client's traffic is not this pool's occupancy. The whole
  // database's figures answer a different question and are reported
  // separately; a cluster under pressure elsewhere must not degrade a
  // container whose own slots are free.
  it("ignores connections that are not this process's own pool", async () => {
    const app = healthRoutes(
      buildPooledStorage([
        {
          client: "other",
          state: "active",
          connections: 18,
          max_connections: 25,
          reserved: 3,
        },
      ]),
      buildBlobs(() => Promise.resolve(false)),
      pooledConfig,
    );

    const body = (await (await app.request("/")).json()) as PoolBody;
    expect(body.database_connections?.pool.in_use).toBe(0);
    expect(body.components.database?.status).toBe("ok");
  });

  // A probe that failed after most of its budget and one that failed at once
  // are different faults, and the branch that said nothing was the one where
  // the number said most.
  it("reports the probe's latency on every branch, not only the healthy one", async () => {
    const refused = healthRoutes(
      buildStorage(() => Promise.reject(new Error("connection refused"))),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );
    const timedOut = healthRoutes(
      buildStorage(() => never),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const down = (await (await refused.request("/")).json()) as PoolBody;
    const degraded = (await (await timedOut.request("/")).json()) as PoolBody;

    expect(down.components.database?.status).toBe("down");
    expect(typeof down.components.database?.latency_ms).toBe("number");

    expect(degraded.components.database?.status).toBe("degraded");
    // Asserted as a number rather than against a duration. What is being
    // pinned is that the field is there; a bound on the value would be
    // measuring the machine this runs on.
    expect(typeof degraded.components.database?.latency_ms).toBe("number");
  }, 15_000);
});
