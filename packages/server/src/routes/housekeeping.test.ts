import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let runs = 0;
let releaseSlow: (() => void) | null = null;

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.housekeeping.register({
    name: "counter",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => {
      runs += 1;
      return Promise.resolve({ runs });
    },
  });
  ctx.housekeeping.register({
    name: "faulty",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => Promise.reject(new Error("the sweep broke")),
  });
  ctx.housekeeping.register({
    name: "slow",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () =>
      new Promise<null>((done) => {
        releaseSlow = () => {
          done(null);
        };
      }),
  });
  await ctx.housekeeping.start();
});

afterAll(async () => {
  releaseSlow?.();
  await ctx.housekeeping.stop();
  await ctx.cleanup();
});

describe("GET /housekeeping", () => {
  it("lists every registered job with its schedule and last run to the operator key", async () => {
    const res = await request(ctx.app, "GET", "/housekeeping", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { name: string; interval_ms: number; last_outcome: null }[];
    };
    expect(body.data.map((job) => job.name)).toEqual([
      "counter",
      "faulty",
      "slow",
    ]);
    expect(body.data[0]).toMatchObject({
      name: "counter",
      interval_ms: 3_600_000,
      running_since: null,
      last_started_at: null,
      last_finished_at: null,
      last_outcome: null,
      last_error: null,
      last_result: null,
    });
    expect(body.data[0]).toHaveProperty("next_run_at");
  });

  it("refuses a working key where the operator key is answered", async () => {
    const operator = await request(ctx.app, "GET", "/housekeeping", {
      key: ctx.operatorKey,
    });
    expect(operator.status).toBe(200);
    const res = await request(ctx.app, "GET", "/housekeeping", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});

describe("POST /housekeeping/:name/run", () => {
  it("runs the job now and answers the run, which the listing then records", async () => {
    const before = runs;
    const res = await request(ctx.app, "POST", "/housekeeping/counter/run", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(runs).toBe(before + 1);
    expect(body).toMatchObject({
      name: "counter",
      outcome: "ok",
      result: { runs: before + 1 },
      error: null,
    });
    expect(typeof body.started_at).toBe("string");
    expect(typeof body.finished_at).toBe("string");

    const listed = await request(ctx.app, "GET", "/housekeeping", {
      key: ctx.operatorKey,
    });
    const { data } = (await listed.json()) as {
      data: Record<string, unknown>[];
    };
    expect(data.find((job) => job.name === "counter")).toMatchObject({
      last_started_at: body.started_at,
      last_finished_at: body.finished_at,
      last_outcome: "ok",
      last_result: { runs: before + 1 },
      running_since: null,
    });
  });

  it("answers a failed run as the run's outcome, not the door's", async () => {
    const res = await request(ctx.app, "POST", "/housekeeping/faulty/run", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "faulty",
      outcome: "error",
      error: "the sweep broke",
      result: null,
    });
  });

  it("answers 404 for a job the instance does not run, where a known one runs", async () => {
    const known = await request(ctx.app, "POST", "/housekeeping/counter/run", {
      key: ctx.operatorKey,
    });
    expect(known.status).toBe(200);
    const res = await request(ctx.app, "POST", "/housekeeping/nothing/run", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("housekeeping_job_not_found");
  });

  it("answers 400 for a name outside the grammar, where a name inside it runs", async () => {
    const inside = await request(ctx.app, "POST", "/housekeeping/counter/run", {
      key: ctx.operatorKey,
    });
    expect(inside.status).toBe(200);
    const res = await request(
      ctx.app,
      "POST",
      "/housekeeping/Not%20A%20Job/run",
      {
        key: ctx.operatorKey,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  /** Resolves once the slow job's run is in flight and can be released. */
  function slowRunStarted(): Promise<() => void> {
    return new Promise((resolve) => {
      const tick = () => {
        const release = releaseSlow;
        if (release) {
          releaseSlow = null;
          resolve(release);
        } else {
          setTimeout(tick, 5);
        }
      };
      tick();
    });
  }

  it("answers 409 while a run holds the job, and runs it again once released", async () => {
    const first = request(ctx.app, "POST", "/housekeeping/slow/run", {
      key: ctx.operatorKey,
    });
    const release = await slowRunStarted();
    const second = await request(ctx.app, "POST", "/housekeeping/slow/run", {
      key: ctx.operatorKey,
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("housekeeping_job_running");

    release();
    expect((await first).status).toBe(200);
    const again = request(ctx.app, "POST", "/housekeeping/slow/run", {
      key: ctx.operatorKey,
    });
    (await slowRunStarted())();
    expect((await again).status).toBe(200);
  });

  it("refuses a working key where the operator key is answered", async () => {
    const operator = await request(
      ctx.app,
      "POST",
      "/housekeeping/counter/run",
      { key: ctx.operatorKey },
    );
    expect(operator.status).toBe(200);
    const res = await request(ctx.app, "POST", "/housekeeping/counter/run", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(403);
  });
});
