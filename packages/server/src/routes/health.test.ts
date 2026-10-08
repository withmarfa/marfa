import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrizzleQueryError } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import {
  healthRoutes,
  instanceReadCaller,
  PROBE_TIMEOUT_MS,
} from "./health.js";
import {
  DISK_DEGRADED_BELOW_BYTES,
  DISK_DOWN_BELOW_BYTES,
  storageProbes,
  WRITE_PROBE_REUSE_MS,
  type HealthProbes,
} from "./health-probes.js";
import { hashApiKey } from "../middleware/auth.js";
import { loadConfig } from "../config.js";
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

/** Probes that answer well: a write that commits and a volume with room. */
function okProbes(overrides: Partial<HealthProbes> = {}): HealthProbes {
  return {
    write: () => Promise.resolve(),
    availableBytes: () => Promise.resolve(10 * DISK_DEGRADED_BELOW_BYTES),
    ...overrides,
  };
}

/** Who asked, as the app would have found out from the key table. */
const nobody = () => Promise.resolve(false);
const instanceReader = () => Promise.resolve(true);

interface HealthBody {
  status: string;
  components: {
    database?: { status: string; error?: string };
    database_write?: { status: string; error?: string };
    disk?: { status: string; error?: string };
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
      {},
      okProbes(),
      nobody,
    );

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.components.database?.status).toBe("ok");
    expect(body.components.blob_storage?.status).toBe("ok");
  });

  it("reports the disk degraded below the reserve, where uploads are refused, and ok above it", async () => {
    const app = (free: number) =>
      healthRoutes(
        buildStorage(() => Promise.resolve(3)),
        buildBlobs(() => Promise.resolve(null)),
        { diskReserveBytes: 4 * DISK_DEGRADED_BELOW_BYTES },
        okProbes({ availableBytes: () => Promise.resolve(free) }),
        instanceReader,
      );
    // Past the fixed line and inside the reserve.
    const inside = await app(2 * DISK_DEGRADED_BELOW_BYTES).request("/");
    expect(inside.status).toBe(200);
    const body = (await inside.json()) as HealthBody;
    expect(body.components.disk?.status).toBe("degraded");
    expect(body.status).toBe("degraded");
    const above = await app(5 * DISK_DEGRADED_BELOW_BYTES).request("/");
    expect(((await above.json()) as HealthBody).components.disk?.status).toBe(
      "ok",
    );
  });

  it("answers degraded instead of hanging when the database probe never returns", async () => {
    const app = healthRoutes(
      buildStorage(() => never),
      buildBlobs(() => Promise.resolve(null)),
      {},
      okProbes(),
      instanceReader,
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
      {},
      okProbes(),
      nobody,
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
      {},
      okProbes(),
      instanceReader,
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

describe("GET /health failing status", () => {
  const healthy = () =>
    healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(null)),
      {},
      okProbes(),
      nobody,
    );

  async function answer(
    router: ReturnType<typeof healthRoutes>,
  ): Promise<{ status: number; body: HealthBody }> {
    const res = await router.request("/");
    return { status: res.status, body: (await res.json()) as HealthBody };
  }

  it("answers 200 and ok while every component answers", async () => {
    const { status, body } = await answer(healthy());
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(Object.keys(body.components).sort()).toEqual([
      "blob_storage",
      "database",
      "database_write",
      "disk",
    ]);
  });

  it("answers 503 and down when the database refuses a read", async () => {
    const { status, body } = await answer(
      healthRoutes(
        buildStorage(() => Promise.reject(new Error("SQLITE_IOERR"))),
        buildBlobs(() => Promise.resolve(null)),
        {},
        okProbes(),
        nobody,
      ),
    );
    expect(status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.components.database?.status).toBe("down");
  });

  it("answers 503 and down when a write is refused although reads answer", async () => {
    const { status, body } = await answer(
      healthRoutes(
        buildStorage(() => Promise.resolve(3)),
        buildBlobs(() => Promise.resolve(null)),
        {},
        okProbes({ write: () => Promise.reject(new Error("SQLITE_READONLY")) }),
      ),
    );
    expect(status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.components.database?.status).toBe("ok");
    expect(body.components.database_write?.status).toBe("down");
  });

  it("answers 200 and degraded when a write has not committed within the budget", async () => {
    const { status, body } = await answer(
      healthRoutes(
        buildStorage(() => Promise.resolve(3)),
        buildBlobs(() => Promise.resolve(null)),
        {},
        okProbes({ write: () => never }),
        nobody,
      ),
    );
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.components.database_write?.status).toBe("degraded");
  }, 15_000);

  it("answers 200 and degraded when another write held the lock past the busy budget", async () => {
    const { status, body } = await answer(
      healthRoutes(
        buildStorage(() => Promise.resolve(3)),
        buildBlobs(() => Promise.resolve(null)),
        {},
        okProbes({
          // Wrapped as the query layer wraps what the driver threw.
          write: () =>
            Promise.reject(
              new Error("Failed query: insert into settings", {
                cause: new MarfaError(
                  ErrorCode.WRITE_CONTENTION,
                  "The row is being written by something else",
                ),
              }),
            ),
        }),
        nobody,
      ),
    );
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.components.database_write?.status).toBe("degraded");
  });

  it.each([
    ["less than the floor", DISK_DOWN_BELOW_BYTES - 1, 503, "down"],
    ["exactly the floor", DISK_DOWN_BELOW_BYTES, 200, "degraded"],
    [
      "less than the warning level",
      DISK_DEGRADED_BELOW_BYTES - 1,
      200,
      "degraded",
    ],
    ["exactly the warning level", DISK_DEGRADED_BELOW_BYTES, 200, "ok"],
  ])("reads %s of free space as %s", async (_name, bytes, code, verdict) => {
    const { status, body } = await answer(
      healthRoutes(
        buildStorage(() => Promise.resolve(3)),
        buildBlobs(() => Promise.resolve(null)),
        {},
        okProbes({ availableBytes: () => Promise.resolve(bytes) }),
        nobody,
      ),
    );
    expect(status).toBe(code);
    expect(body.components.disk?.status).toBe(verdict);
  });

  it("calls free space it could not read degraded, never down", async () => {
    const { status, body } = await answer(
      healthRoutes(
        buildStorage(() => Promise.resolve(3)),
        buildBlobs(() => Promise.resolve(null)),
        {},
        okProbes({
          availableBytes: () => Promise.reject(new Error("statfs unsupported")),
        }),
        instanceReader,
      ),
    );
    expect(status).toBe(200);
    expect(body.components.disk?.status).toBe("degraded");
    expect(body.components.disk?.error).toContain("statfs unsupported");
  });

  it("answers 503 when blob storage refuses", async () => {
    const { status, body } = await answer(
      healthRoutes(
        buildStorage(() => Promise.resolve(3)),
        buildBlobs(() => Promise.reject(new Error("EIO"))),
        {},
        okProbes(),
        nobody,
      ),
    );
    expect(status).toBe(503);
    expect(body.components.blob_storage?.status).toBe("down");
  });
});

describe("GET /health error text", () => {
  // Every failing component at once, so one answer carries every message.
  const failing = (isOperator: () => Promise<boolean>) =>
    healthRoutes(
      buildStorage(() =>
        Promise.reject(new Error("unable to open /data/marfa.db")),
      ),
      buildBlobs(() => Promise.reject(new Error("EACCES /data/blobs"))),
      {},
      okProbes({
        write: () => Promise.reject(new Error("SQLITE_FULL")),
        availableBytes: () => Promise.resolve(0),
      }),
      isOperator,
    );

  async function components(
    isOperator: () => Promise<boolean>,
  ): Promise<Record<string, { status: string; error?: string }>> {
    const res = await failing(isOperator).request("/");
    return ((await res.json()) as { components: Record<string, never> })
      .components;
  }

  it("tells an instance reader what each component said", async () => {
    // The witness for the case below: the same answer, producible.
    const seen = await components(instanceReader);
    expect(seen.database?.error).toContain("/data/marfa.db");
    expect(seen.database_write?.error).toContain("SQLITE_FULL");
    expect(seen.disk?.error).toContain("bytes available");
    expect(seen.blob_storage?.error).toContain("EACCES");
  });

  it("tells a caller that is not an instance reader no error text, though every component is down", async () => {
    const seen = await components(nobody);
    expect(Object.values(seen).map((one) => one.status)).toEqual([
      "down",
      "down",
      "down",
      "down",
    ]);
    for (const one of Object.values(seen)) {
      expect(one).not.toHaveProperty("error");
    }
  });
});

describe("GET /health error text from a wrapped failure", () => {
  it("names a database failure with its code rather than the statement the query layer wraps it in", async () => {
    const wrapped = new Error('Failed query: insert into "settings"', {
      cause: new Error("SQLITE_FULL: database or disk is full"),
    });
    const res = await healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(null)),
      {},
      okProbes({ write: () => Promise.reject(wrapped) }),
      instanceReader,
    ).request("/");

    const body = (await res.json()) as HealthBody;

    expect(body.components.database_write?.error).toBe(
      "Database operation failed (SQLITE_FULL)",
    );
  });
});

describe("GET /health error text from a failed query with no failure inside it", () => {
  it("names a database failure and neither the statement nor the values it was bound to", async () => {
    const value = "bound-value-3e9d51c0";
    const bare = new DrizzleQueryError(
      'insert into "settings" ("key", "value") values (?, ?)',
      ["probe", value],
      undefined,
    );
    // The witness: the library's own message carries the value.
    expect(bare.message).toContain(value);
    const res = await healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(null)),
      {},
      okProbes({ write: () => Promise.reject(bare) }),
      instanceReader,
    ).request("/");

    const body = (await res.json()) as HealthBody;

    expect(body.components.database_write?.error).toBe(
      "Database operation failed",
    );
    expect(JSON.stringify(body)).not.toContain(value);
    expect(JSON.stringify(body)).not.toContain("settings");
  });
});

describe("instanceReadCaller", () => {
  const SALT = "a-salt-for-this-test";
  const keys = (readsInstance: boolean) =>
    ({
      validate: (hash: string) =>
        Promise.resolve(
          hash === hashApiKey("marfa_k1_known", SALT)
            ? { permissions: readsInstance ? ["instance.read"] : [] }
            : null,
        ),
    }) as unknown as Parameters<typeof instanceReadCaller>[0]["keys"];

  it("requires instance.read on a valid stored key", async () => {
    const asked = (storageKeys: ReturnType<typeof keys>, header?: string) =>
      instanceReadCaller({ keys: storageKeys }, SALT)(header);

    expect(await asked(keys(true), "Bearer marfa_k1_known")).toBe(true);
    expect(await asked(keys(false), "Bearer marfa_k1_known")).toBe(false);
    expect(await asked(keys(true), "Bearer marfa_k1_unknown")).toBe(false);
    expect(await asked(keys(true), "marfa_k1_known")).toBe(false);
    expect(await asked(keys(true), undefined)).toBe(false);
  });

  it("says no, and does not throw, when the database cannot look the key up", async () => {
    const asked = instanceReadCaller(
      {
        keys: {
          validate: () => Promise.reject(new Error("unreadable")),
        },
      } as unknown as Parameters<typeof instanceReadCaller>[0],
      SALT,
    );

    expect(await asked("Bearer marfa_k1_known")).toBe(false);
  });
});

describe("the probes the app mounts", () => {
  function settingsThat(set: () => Promise<void>) {
    const calls: string[] = [];
    return {
      calls,
      storage: {
        settings: {
          set: (key: string) => {
            calls.push(key);
            return set();
          },
        },
      } as unknown as Parameters<typeof storageProbes>[0],
    };
  }

  const paths = { sqlitePath: ":memory:", blobPath: "." };

  it("commits one write and answers the callers that follow it within the reuse window from that one", async () => {
    let clock = 1_000_000;
    const { calls, storage } = settingsThat(() => Promise.resolve());
    const probes = storageProbes(storage, paths, () => clock);

    await Promise.all([probes.write(), probes.write(), probes.write()]);
    await probes.write();
    expect(calls).toHaveLength(1);

    clock += WRITE_PROBE_REUSE_MS;
    await probes.write();
    expect(calls).toHaveLength(2);
  });

  it("answers a refused write with the refusal until the reuse window ends, and then tries again", async () => {
    let clock = 1_000_000;
    let refuse = true;
    const { calls, storage } = settingsThat(() =>
      refuse ? Promise.reject(new Error("SQLITE_FULL")) : Promise.resolve(),
    );
    const probes = storageProbes(storage, paths, () => clock);

    await expect(probes.write()).rejects.toThrow("SQLITE_FULL");
    await expect(probes.write()).rejects.toThrow("SQLITE_FULL");
    expect(calls).toHaveLength(1);

    refuse = false;
    clock += WRITE_PROBE_REUSE_MS;
    await expect(probes.write()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("measures real room on the volumes it is given", async () => {
    const { storage } = settingsThat(() => Promise.resolve());

    const bytes = await storageProbes(storage, {
      sqlitePath: join(tmpdir(), "marfa.db"),
      blobPath: tmpdir(),
    }).availableBytes();

    expect(bytes).toBeGreaterThan(0);
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
  // Through the settings, so the case covers the names an operator sets.
  const build = (env: Record<string, string>) =>
    healthRoutes(
      buildStorage(() => Promise.resolve(1)),
      buildBlobs(() => Promise.resolve(null)),
      loadConfig(env),
      okProbes(),
      nobody,
    );

  it("reports what the deployment states about itself", async () => {
    const app = build({
      MARFA_PLACEMENT_REGION: "lon1",
      MARFA_PLACEMENT_LOCATION: "London",
      MARFA_PLACEMENT_COUNTRY: "GB",
    });
    const body = (await (await app.request("/")).json()) as HealthBody;
    expect(body.placement).toEqual({
      region: "lon1",
      location: "London",
      country: "GB",
    });
  });

  // Nothing sets these unless an operator does. A deployment that has not
  // been told where it is has to be able to say nothing rather than say an
  // empty string, because a caller reading "" as a region would compare it
  // against the expected one and fail a deploy that is fine.
  it("omits the block entirely when nothing is configured", async () => {
    const body = (await (await build({}).request("/")).json()) as HealthBody;
    expect(body.placement).toBeUndefined();
  });

  it("reports a partial placement rather than dropping it", async () => {
    const app = build({ MARFA_PLACEMENT_REGION: "lon1" });
    const body = (await (await app.request("/")).json()) as HealthBody;
    expect(body.placement).toEqual({ region: "lon1" });
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
      {},
      okProbes(),
      nobody,
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
        { table: "blob_stores", column: "kind", value: "tape", count: 40 },
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
      values: [
        { table: "blob_stores", column: "kind", value: "tape", count: 40 },
      ],
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
        { table: "blob_stores", column: "kind", value: "tape", count: 40 },
      ],
    });

    const text = await (await build().request("/")).text();
    expect(text).not.toContain("tape");
    expect(text).not.toContain("blob_stores");
  });
});
