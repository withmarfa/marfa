import { afterEach, describe, expect, it } from "vitest";
import { healthRoutes, PROBE_TIMEOUT_MS } from "./health.js";
import { setStoredValueScan } from "../storage/stored-value-scan.js";
import type { Storage } from "../storage/interface.js";
import type { BlobLayer } from "../storage/blob-layer.js";

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
 * unbounded: the database probe waits on the database, so a held
 * database turned the liveness endpoint into the one surface that could
 * say nothing while ordinary requests were still being served.
 *
 * These use fakes rather than a database on purpose — the property under
 * test is what the endpoint does when a probe does not come back, and a
 * real database is the wrong instrument for producing that.
 */

const never = new Promise<never>(() => {
  // Deliberately never settles: this is the shape of a probe that never
  // comes back.
});

function buildStorage(count: () => Promise<number>): Storage {
  return { keys: { count } } as unknown as Storage;
}

function buildBlobs(
  has: () => Promise<{ size_bytes: number } | null>,
): BlobLayer {
  return { disk: { has } } as unknown as BlobLayer;
}

interface HealthBody {
  status: string;
  components: {
    database?: { status: string; error?: string };
    blob_storage?: { status: string; error?: string };
  };
  placement?: { region?: string; location?: string; country?: string };
}

interface StoredValueBody extends HealthBody {
  unrecognized_stored_values?: { rows: number; scanned: boolean };
}

describe("GET /health", () => {
  it("reports ok when both probes answer", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(null)),
    );

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.components.database?.status).toBe("ok");
    expect(body.components.blob_storage?.status).toBe("ok");
  });

  it("answers degraded instead of hanging when the database probe never returns", async () => {
    const app = healthRoutes(
      buildStorage(() => never),
      buildBlobs(() => Promise.resolve(null)),
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
    expect(body.components.database?.error).toContain("held");
  }, 15_000);

  it("answers degraded instead of hanging when blob storage never returns", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => never),
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
      buildBlobs(() => Promise.resolve(null)),
    );

    const res = await app.request("/");
    const body = (await res.json()) as HealthBody;
    // `down` means the database answered with a refusal; `degraded` means
    // no answer arrived. Collapsing them would lose the distinction that
    // tells an operator whether the database is reachable and unhappy or
    // not answering at all.
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
      buildBlobs(() => Promise.resolve(null)),
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
      buildBlobs(() => Promise.resolve(null)),
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
    // database whose migration has not landed, the query fails on
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
