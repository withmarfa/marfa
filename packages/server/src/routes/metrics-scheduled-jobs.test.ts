/**
 * The `scheduled_jobs` section of `GET /metrics`, from the route's side.
 *
 * Its own file rather than a case in `metrics.test.ts`, because the route
 * caches its response for a minute: the sibling file asserts the section is
 * absent where no reporter is installed, and one cache cannot hold both
 * answers. The survey the reporter runs is covered against a real pg-boss
 * in `scheduled/job-metrics.test.ts`; what is under test here is that an
 * installed reporter reaches the payload intact.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  setScheduledJobsReporter,
  type ScheduledJobsReport,
} from "../scheduled/job-metrics.js";

let ctx: TestContext;

const REPORT: ScheduledJobsReport = {
  window_hours: 24,
  jobs: [
    {
      name: "enrichment-sweep",
      last_completed_at: "2026-08-26T09:15:00.000Z",
      last_queue_failure_at: null,
      ticks: 677,
      slowest_tick_ms: 4210,
    },
    {
      name: "trash-purge",
      last_completed_at: null,
      last_queue_failure_at: null,
      ticks: 0,
      slowest_tick_ms: null,
    },
  ],
};

beforeAll(async () => {
  ctx = await createTestContext();
  // Installed before the first request: the route caches for a minute, so a
  // reporter added after one would be invisible for the rest of the file.
  setScheduledJobsReporter(() => Promise.resolve(REPORT));
});

afterAll(async () => {
  setScheduledJobsReporter(undefined);
  await ctx.cleanup();
});

describe("GET /metrics scheduled_jobs", () => {
  it("publishes the installed reporter's reading", async () => {
    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scheduled_jobs?: ScheduledJobsReport;
    };

    expect(body.scheduled_jobs).toBeDefined();
    expect(body.scheduled_jobs?.window_hours).toBe(24);
    expect(body.scheduled_jobs?.jobs.map((job) => job.name)).toEqual([
      "enrichment-sweep",
      "trash-purge",
    ]);

    // The distinction the whole section exists for, end to end: a job that
    // ran and one that has not run since boot are different rows, not one
    // silence.
    const ran = body.scheduled_jobs?.jobs[0];
    const never = body.scheduled_jobs?.jobs[1];
    expect(ran?.last_completed_at).toBe("2026-08-26T09:15:00.000Z");
    expect(ran?.ticks).toBe(677);
    expect(ran?.slowest_tick_ms).toBe(4210);
    expect(never?.last_completed_at).toBeNull();
    expect(never?.ticks).toBe(0);
  });
});
