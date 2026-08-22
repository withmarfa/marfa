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
    dead_letters?: {
      status: string;
      error?: string;
      count?: number;
      oldest_failed_at?: string | null;
      connection_ids?: string[];
    };
  };
  placement?: { region?: string; location?: string; country?: string };
  database_connections?: unknown;
}

function buildDeadLetters(
  summary: () => Promise<{
    count: number;
    oldest_failed_at: string | null;
    connection_ids: string[];
  }>,
) {
  return {
    summary,
    list: () => Promise.resolve([]),
    replay: () => Promise.resolve({ replayed: true as const, id: "x" }),
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

  // The point of the component. A dispatch that gave up was already recorded
  // honestly on an admin route nobody calls, so a captured email sat dropped
  // for two days behind a green liveness check. Degrading is what makes the
  // external poller that already watches this endpoint say so.
  it("degrades and names the connections when a dispatch has given up", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
      undefined,
      buildDeadLetters(() =>
        Promise.resolve({
          count: 2,
          oldest_failed_at: "2026-08-20T13:39:39.925Z",
          connection_ids: ["01a01ef6-fb73-7c70-8cce-4dc9d02ff14d"],
        }),
      ),
    );

    const body = (await (await app.request("/")).json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.components.dead_letters?.status).toBe("degraded");
    expect(body.components.dead_letters?.count).toBe(2);
    expect(body.components.dead_letters?.oldest_failed_at).toBe(
      "2026-08-20T13:39:39.925Z",
    );
    // Naming where to look is half the value: the poller says the instance is
    // degraded, and the same response says which connection dropped work.
    expect(body.components.dead_letters?.connection_ids).toEqual([
      "01a01ef6-fb73-7c70-8cce-4dc9d02ff14d",
    ]);
    expect(body.components.dead_letters?.error).toContain("reached nobody");
  });

  it("stays ok when the queue is empty, and says so rather than staying silent", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
      undefined,
      buildDeadLetters(() =>
        Promise.resolve({
          count: 0,
          oldest_failed_at: null,
          connection_ids: [],
        }),
      ),
    );

    const body = (await (await app.request("/")).json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.components.dead_letters?.status).toBe("ok");
    expect(body.components.dead_letters?.count).toBe(0);
    expect(body.components.dead_letters?.error).toBeUndefined();
  });

  // A deployment with no local substrate has no dispatch queue. Absent is the
  // honest answer; a zero would be a claim that nothing has failed.
  it("omits the component entirely with no local substrate", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const body = (await (await app.request("/")).json()) as HealthBody;
    expect(body.components.dead_letters).toBeUndefined();
  });

  // The failure that matters most for this component: a probe that cannot
  // find out must not answer zero. A zero here would be the endpoint claiming
  // nothing has failed on the strength of a query that did not run, which is
  // the reporting shape the whole component exists to remove.
  it("omits the component rather than reporting zero when the probe cannot answer", async () => {
    for (const broken of [
      () => Promise.reject(new Error("queue unreadable")),
      () => never,
    ]) {
      const app = healthRoutes(
        buildStorage(() => Promise.resolve(3)),
        buildBlobs(() => Promise.resolve(false)),
        config,
        undefined,
        buildDeadLetters(broken),
      );

      const body = (await (await app.request("/")).json()) as HealthBody;
      expect(body.components.dead_letters).toBeUndefined();
      expect(body.status).toBe("ok");
    }
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
