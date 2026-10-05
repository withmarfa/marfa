import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let runs = 0;
/** Releases the slow run in flight; resolving twice is harmless, so the
 *  file's teardown can call it whatever a test left. */
let releaseSlow: (() => void) | null = null;
let slowStarts = 0;

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.backgroundJobs.register({
    name: "counter",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => {
      runs += 1;
      return Promise.resolve({ runs });
    },
  });
  ctx.backgroundJobs.register({
    name: "silent",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => Promise.resolve(null),
  });
  ctx.backgroundJobs.register({
    name: "faulty",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => Promise.reject(new Error("the sweep broke")),
  });
  ctx.backgroundJobs.register({
    name: "slow",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () =>
      new Promise<null>((done) => {
        slowStarts += 1;
        releaseSlow = () => {
          done(null);
        };
      }),
  });
  await ctx.backgroundJobs.start();
});

afterAll(async () => {
  releaseSlow?.();
  await ctx.backgroundJobs.stop();
  await ctx.cleanup();
});

describe("GET /background-jobs", () => {
  it("lists every registration with its schedule and last run to the operator key", async () => {
    const res = await request(ctx.app, "GET", "/background-jobs", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { name: string; interval_ms: number; last_outcome: null }[];
    };
    expect(body.data.map((row) => row.name)).toEqual([
      "counter",
      "faulty",
      "silent",
      "slow",
    ]);
    const fresh = body.data.find((row) => row.name === "silent");
    expect(fresh).toMatchObject({
      interval_ms: 3_600_000,
      running_since: null,
      last_started_at: null,
      last_finished_at: null,
      last_outcome: null,
      last_error: null,
      last_result: null,
    });
    expect(fresh).toHaveProperty("next_run_at");
    // The witness for the nulls: a name that has run carries its run.
    const ran = await request(ctx.app, "POST", "/background-jobs/silent/run", {
      key: ctx.operatorKey,
    });
    expect(ran.status).toBe(200);
    const after = (await (
      await request(ctx.app, "GET", "/background-jobs", {
        key: ctx.operatorKey,
      })
    ).json()) as { data: Record<string, unknown>[] };
    expect(after.data.find((row) => row.name === "silent")).toMatchObject({
      running_since: null,
      last_outcome: "ok",
      last_error: null,
      last_result: null,
    });
    expect(
      typeof after.data.find((row) => row.name === "silent")?.last_started_at,
    ).toBe("string");
  });

  it("refuses a working key where the operator key is answered", async () => {
    const operator = await request(ctx.app, "GET", "/background-jobs", {
      key: ctx.operatorKey,
    });
    expect(operator.status).toBe(200);
    const res = await request(ctx.app, "GET", "/background-jobs", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});

describe("POST /background-jobs/:name/run", () => {
  it("runs the name now and answers the run, which the listing then records", async () => {
    const before = runs;
    const res = await request(ctx.app, "POST", "/background-jobs/counter/run", {
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

    const listed = await request(ctx.app, "GET", "/background-jobs", {
      key: ctx.operatorKey,
    });
    const { data } = (await listed.json()) as {
      data: Record<string, unknown>[];
    };
    expect(data.find((row) => row.name === "counter")).toMatchObject({
      last_started_at: body.started_at,
      last_finished_at: body.finished_at,
      last_outcome: "ok",
      last_result: { runs: before + 1 },
      running_since: null,
    });
  });

  it("answers a run that reported nothing with a null result, present in the body", async () => {
    const res = await request(ctx.app, "POST", "/background-jobs/silent/run", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("result", null);
    expect(body).toMatchObject({ name: "silent", outcome: "ok" });
  });

  it("answers a failed run as the run's outcome, not the door's", async () => {
    const res = await request(ctx.app, "POST", "/background-jobs/faulty/run", {
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

  it("answers 404 for a name the instance does not run, where a known one runs", async () => {
    const known = await request(
      ctx.app,
      "POST",
      "/background-jobs/counter/run",
      {
        key: ctx.operatorKey,
      },
    );
    expect(known.status).toBe(200);
    const res = await request(ctx.app, "POST", "/background-jobs/nothing/run", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("background_job_not_found");
  });

  it("answers 400 for a name outside the grammar, where a name inside it runs", async () => {
    const inside = await request(
      ctx.app,
      "POST",
      "/background-jobs/counter/run",
      {
        key: ctx.operatorKey,
      },
    );
    expect(inside.status).toBe(200);
    const res = await request(
      ctx.app,
      "POST",
      "/background-jobs/Not%20A%20Job/run",
      {
        key: ctx.operatorKey,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  /** Resolves with the release for the slow run that started after `seen`
   *  starts, once it is in flight. */
  function slowRunStarted(seen: number): Promise<() => void> {
    return new Promise((resolve) => {
      const tick = () => {
        if (slowStarts > seen && releaseSlow) {
          resolve(releaseSlow);
        } else {
          setTimeout(tick, 5);
        }
      };
      tick();
    });
  }

  it("answers 409 while a run holds the name, and runs it again once released", async () => {
    const seen = slowStarts;
    const first = request(ctx.app, "POST", "/background-jobs/slow/run", {
      key: ctx.operatorKey,
    });
    const release = await slowRunStarted(seen);
    const second = await request(ctx.app, "POST", "/background-jobs/slow/run", {
      key: ctx.operatorKey,
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("background_job_running");

    release();
    expect((await first).status).toBe(200);
    const again = request(ctx.app, "POST", "/background-jobs/slow/run", {
      key: ctx.operatorKey,
    });
    (await slowRunStarted(seen + 1))();
    expect((await again).status).toBe(200);
  });

  it("refuses a working key where the operator key is answered", async () => {
    const operator = await request(
      ctx.app,
      "POST",
      "/background-jobs/counter/run",
      { key: ctx.operatorKey },
    );
    expect(operator.status).toBe(200);
    const res = await request(ctx.app, "POST", "/background-jobs/counter/run", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(403);
  });
});
