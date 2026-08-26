/**
 * What `GET /metrics` does when the scheduled-job reporter throws.
 *
 * Its own file because the route caches its response for a minute, so one
 * cache holds one answer and the healthy case lives in
 * `metrics-scheduled-jobs.test.ts` beside it.
 *
 * The property is that the newest and least load-bearing section cannot
 * take the rest of the payload down with it. Two ways to reach that in
 * production: the query reads pg-boss's private schema against a
 * caret-ranged dependency, and the reporter's closure outlives the
 * connection pool by however long a request takes to arrive during a
 * graceful drain.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { setScheduledJobsReporter } from "../scheduled/job-metrics.js";
import * as logger from "../middleware/logger.js";

let ctx: TestContext;
let warnings: string[];

beforeAll(async () => {
  ctx = await createTestContext();
  warnings = [];
  vi.spyOn(logger, "log").mockImplementation((level, message) => {
    if (level === "warn") warnings.push(message);
  });
  setScheduledJobsReporter(() =>
    Promise.reject(new Error('column "deletion_seconds" does not exist')),
  );
});

afterAll(async () => {
  setScheduledJobsReporter(undefined);
  vi.restoreAllMocks();
  await ctx.cleanup();
});

describe("GET /metrics with a failing scheduled-job reporter", () => {
  it("still answers, with the rest of the payload intact", async () => {
    const res = await request(ctx.app, "GET", "/metrics", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The counters that were trustworthy before this section existed are
    // all still there; only the section that could not be read is gone.
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("connections");
    expect(body).toHaveProperty("keys");
    expect(body).toHaveProperty("uptime_seconds");
    expect(body).not.toHaveProperty("scheduled_jobs");

    // Absence has two causes — no reporter, and a reporter that threw — so
    // pin which one happened here rather than accepting the outcome.
    expect(warnings).toContain("Scheduled-job metrics unavailable");
  });
});
