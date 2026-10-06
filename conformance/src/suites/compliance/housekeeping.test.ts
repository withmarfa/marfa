import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "housekeeping"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** The sweeps every instance runs whatever its configuration. */
const ALWAYS_LISTED = [
  "audit-cleanup",
  "event-log-cleanup",
  "rate-limit-cleanup",
  "revoked-key-reap",
  "trash-purge",
  "version-thinning",
  "webhook-poll",
  "webhook-schedule",
];

describe("the housekeeping the server runs on itself", () => {
  it("lists the housekeeping jobs to the operator key", async () => {
    const listed = await getOperatorClient().listHousekeeping();
    expect(listed.status).toBe(200);
    await expectMatchesSchema("GET", "/housekeeping", 200, listed.data);
    const names = listed.data.data.map((row) => row.name);
    for (const name of ALWAYS_LISTED) expect(names).toContain(name);
    for (const row of listed.data.data) {
      expect(row.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(row.interval_ms).toBeGreaterThan(0);
      expect(Date.parse(row.next_run_at)).not.toBeNaN();
      expect([null, "ok", "error"]).toContain(row.last_outcome);
    }
  });

  it("refuses the listing to a working key", async () => {
    expect((await getOperatorClient().listHousekeeping()).status).toBe(200);
    const listed = await client.listHousekeeping();
    expect(listed.status).toBe(403);
    expect(listed.error?.error.code).toBe("forbidden");
  });

  it("runs a housekeeping job on demand and the listing records the run", async () => {
    const operator = getOperatorClient();
    const run = await operator.runHousekeeping("rate-limit-cleanup");
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/housekeeping/{name}/run",
      200,
      run.data,
    );
    expect(run.data.name).toBe("rate-limit-cleanup");
    expect(run.data.outcome).toBe("ok");
    expect(Date.parse(run.data.started_at)).not.toBeNaN();
    expect(Date.parse(run.data.finished_at)).toBeGreaterThanOrEqual(
      Date.parse(run.data.started_at),
    );
    // The sweep reports what it swept, and there was nothing to sweep:
    // rate limiting is off for a run, so no window row ever expires.
    expect(run.data.result).toEqual({ deleted: 0 });

    const listed = await operator.listHousekeeping();
    const row = listed.data.data.find(
      (candidate) => candidate.name === "rate-limit-cleanup",
    );
    expect(row).toMatchObject({
      running_since: null,
      last_started_at: run.data.started_at,
      last_finished_at: run.data.finished_at,
      last_outcome: "ok",
      last_result: { deleted: 0 },
    });
    // Due again no later than an interval after the finish, and never
    // before this run started: a run ahead of schedule leaves the schedule
    // where it was, and one on schedule sets the next.
    const nextRunAt = Date.parse(row?.next_run_at ?? "");
    expect(nextRunAt).toBeGreaterThan(Date.parse(run.data.started_at));
    expect(nextRunAt).toBeLessThanOrEqual(
      Date.parse(run.data.finished_at) + (row?.interval_ms ?? 0),
    );
  });

  it("answers 404 for a name the instance does not run, where a listed one runs", async () => {
    const operator = getOperatorClient();
    expect((await operator.runHousekeeping("trash-purge")).status).toBe(200);
    // A name no registration carries. A name switched off by configuration
    // answers the same, and the referee, which boots with enrichment off,
    // cannot show that name listed; the server's own suite proves that
    // side from both ends.
    const unknown = await operator.runHousekeeping("nothing-runs-this");
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("housekeeping_job_not_found");
  });

  it("leaves a job a setting switches off out of the listing, and answers 404 for it", async () => {
    // The referee boots with enrichment off. The enrichment fixtures boot
    // servers with it on and run this name there.
    const operator = getOperatorClient();
    const listed = await operator.listHousekeeping();
    expect(listed.status).toBe(200);
    const names = listed.data.data.map((row) => row.name);
    expect(names).toContain("trash-purge");
    expect(names).not.toContain("enrichment-sweep");
    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(404);
    expect(run.error?.error.code).toBe("housekeeping_job_not_found");
  });

  it("refuses a retention beyond its range and keeps the stored one", async () => {
    const before = await client.getConfig();
    expect(before.status).toBe(200);
    const config = before.data as Record<string, unknown>;
    for (const [field, beyond] of [
      ["audit_retention_days", 36501],
      ["trash_retention_days", 36501],
      ["event_log_retention_hours", 876001],
    ] as const) {
      const refused = await client.updateConfig({ ...config, [field]: beyond });
      expect(refused.status, field).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      const after = await client.getConfig();
      expect((after.data as Record<string, unknown>)[field], field).toBe(
        config[field],
      );
    }
  });

  it("refuses a malformed name and a working key", async () => {
    const operator = getOperatorClient();
    expect((await operator.runHousekeeping("trash-purge")).status).toBe(200);
    const malformed = await operator.runHousekeeping("Not%20A%20Job");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
    const working = await client.runHousekeeping("trash-purge");
    expect(working.status).toBe(403);
    expect(working.error?.error.code).toBe("forbidden");
  });
});
