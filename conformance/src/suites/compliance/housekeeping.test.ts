import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getManagementClient,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { bootFreshServer } from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

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
  "auth-session-cleanup",
  "blob-integrity",
  "blob-replicate",
  "event-log-cleanup",
  "feed-expiry",
  "inbound-delivery-cleanup",
  "rate-limit-cleanup",
  "revoked-key-reap",
  "trash-purge",
  "version-thinning",
  "webhook-poll",
  "webhook-schedule",
];

describe("the housekeeping the server runs on itself", () => {
  it("lists the housekeeping jobs to the management key", async () => {
    const listed = await getManagementClient().listHousekeeping();
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
    expect((await getManagementClient().listHousekeeping()).status).toBe(200);
    const listed = await client.listHousekeeping();
    expect(listed.status).toBe(403);
    expect(listed.error?.error.code).toBe("forbidden");
  });

  it("runs a housekeeping job on demand and the listing records the run", async () => {
    const server = await bootFreshServer("housekeeping-cleanup");
    try {
      const operator = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: server.managementKey,
      });
      const windowKey = "housekeeping-expired-window";
      const readWindow = () =>
        withInstanceDatabase(server.sqlitePath, (db) =>
          db
            .prepare(
              "SELECT count FROM rate_limit_windows WHERE family = ? AND window_key = ?",
            )
            .get("rate", windowKey),
        );
      withInstanceDatabase(server.sqlitePath, (db) => {
        db.prepare(
          "INSERT INTO rate_limit_windows (family, window_key, count, expires_at) VALUES (?, ?, ?, ?)",
        ).run("rate", windowKey, 1, "2000-01-01T00:00:00.000Z");
      });
      expect(readWindow()).toMatchObject({ count: 1 });
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
      expect(readWindow()).toBeUndefined();

      const listed = await operator.listHousekeeping();
      const row = listed.data.data.find(
        (candidate) => candidate.name === "rate-limit-cleanup",
      );
      expect(row).toMatchObject({
        running_since: null,
        last_started_at: run.data.started_at,
        last_finished_at: run.data.finished_at,
        last_outcome: "ok",
        last_error: run.data.error,
        last_result: run.data.result,
      });
      // Due again no later than an interval after the finish, and never
      // before this run started: a run ahead of schedule leaves the schedule
      // where it was, and one on schedule sets the next.
      const nextRunAt = Date.parse(row?.next_run_at ?? "");
      expect(nextRunAt).toBeGreaterThan(Date.parse(run.data.started_at));
      expect(nextRunAt).toBeLessThanOrEqual(
        Date.parse(run.data.finished_at) + (row?.interval_ms ?? 0),
      );
    } finally {
      await server.stop();
    }
  });

  it("answers 404 for a name the instance does not run, where a listed one runs", async () => {
    const operator = getManagementClient();
    expect((await operator.runHousekeeping("trash-purge")).status).toBe(200);
    const unknown = await operator.runHousekeeping("nothing-runs-this");
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("housekeeping_job_not_found");
  });

  it("keeps live-switchable jobs listed when their environment default is off", async () => {
    // A later /config change can start the job without restarting the server.
    const operator = getManagementClient();
    const listed = await operator.listHousekeeping();
    expect(listed.status).toBe(200);
    const names = listed.data.data.map((row) => row.name);
    expect(names).toContain("trash-purge");
    expect(names).toContain("enrichment-sweep");
    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
  });

  it("refuses a retention beyond its range and keeps the stored one", async () => {
    const before = await client.getConfig();
    expect(before.status).toBe(200);
    const config = before.data as Record<string, unknown>;
    const ranges = [
      ["audit_retention_days", 36500],
      ["trash_retention_days", 36500],
      ["inbound_handled_retention_days", 36500],
      ["inbound_pending_retention_days", 36500],
      ["event_log_retention_hours", 876000],
    ] as const;
    try {
      for (const [field, max] of ranges) {
        // The witness: the same body with the largest value is accepted.
        const accepted = await client.updateConfig({ ...config, [field]: max });
        expect(accepted.status, field).toBe(200);
        const stored = (await client.getConfig()).data as Record<
          string,
          unknown
        >;
        for (const beyond of [max + 1, -1, 1.5]) {
          const refused = await client.updateConfig({
            ...config,
            [field]: beyond,
          });
          expect(refused.status, `${field} ${String(beyond)}`).toBe(400);
          expect(refused.error?.error.code).toBe("validation_error");
          const after = await client.getConfig();
          expect(after.data, `${field} ${String(beyond)}`).toEqual(stored);
        }
      }
    } finally {
      expect((await client.updateConfig(config)).status).toBe(200);
    }
  });

  it("runs each cleanup job at the largest retention it accepts", async () => {
    const operator = getManagementClient();
    const before = await client.getConfig();
    expect(before.status).toBe(200);
    const config = before.data as Record<string, unknown>;
    try {
      const widest = await client.updateConfig({
        ...config,
        audit_retention_days: 36500,
        trash_retention_days: 36500,
        inbound_handled_retention_days: 36500,
        inbound_pending_retention_days: 36500,
        event_log_retention_hours: 876000,
      });
      expect(widest.status, JSON.stringify(widest.error)).toBe(200);
      for (const name of [
        "audit-cleanup",
        "trash-purge",
        "event-log-cleanup",
        "inbound-delivery-cleanup",
      ]) {
        const run = await operator.runHousekeeping(name);
        expect(run.status, name).toBe(200);
        expect(run.data.outcome, `${name}: ${String(run.data.error)}`).toBe(
          "ok",
        );
      }
    } finally {
      expect((await client.updateConfig(config)).status).toBe(200);
    }
  });

  it("refuses a malformed name and a working key", async () => {
    const operator = getManagementClient();
    expect((await operator.runHousekeeping("trash-purge")).status).toBe(200);
    const malformed = await operator.runHousekeeping("Not%20A%20Job");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
    const working = await client.runHousekeeping("trash-purge");
    expect(working.status).toBe(403);
    expect(working.error?.error.code).toBe("forbidden");
  });
});
