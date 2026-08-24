import { describe, expect, it } from "vitest";
import { healthRoutes } from "./health.js";
import type { AppConfig } from "../config.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";

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
    expect(Date.now() - started).toBeLessThan(3_000);
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
    expect(elapsed).toBeLessThan(10_000);

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
