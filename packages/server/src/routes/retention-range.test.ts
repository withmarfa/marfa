import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { registerHousekeepingJobs } from "../housekeeping/registrations.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  registerHousekeepingJobs(
    ctx.housekeeping,
    ctx.storage,
    ctx.blobs,
    ctx.config,
  );
  await ctx.housekeeping.start();
});
afterAll(async () => {
  await ctx.housekeeping.stop();
  await ctx.cleanup();
});

it.each([
  ["audit_retention_days", 36500],
  ["event_log_retention_hours", 876000],
  ["trash_retention_days", 36500],
  ["inbound_handled_retention_days", 36500],
  ["inbound_pending_retention_days", 36500],
])(
  "accepts %s at its cleanup horizon and refuses the next integer without replacing it",
  async (field, maximum) => {
    const accepted = await request(ctx.app, "PUT", "/config", {
      key: ctx.workingKey,
      body: { [field]: maximum },
    });
    expect(accepted.status).toBe(200);
    const refused = await request(ctx.app, "PUT", "/config", {
      key: ctx.workingKey,
      body: { [field]: maximum + 1 },
    });
    expect(refused.status).toBe(400);
    const read = await request(ctx.app, "GET", "/config", {
      key: ctx.workingKey,
    });
    expect(await read.json()).toMatchObject({ [field]: maximum });
  },
);

it("runs native stores and registered cleanup jobs at accepted maximums and zero", async () => {
  for (const body of [
    {
      audit_retention_days: 36500,
      event_log_retention_hours: 876000,
      trash_retention_days: 36500,
      inbound_handled_retention_days: 36500,
      inbound_pending_retention_days: 36500,
    },
    {
      audit_retention_days: 0,
      event_log_retention_hours: 0,
      trash_retention_days: 0,
      inbound_handled_retention_days: 0,
      inbound_pending_retention_days: 0,
    },
  ]) {
    expect(
      (await request(ctx.app, "PUT", "/config", { key: ctx.workingKey, body }))
        .status,
    ).toBe(200);
    if (body.audit_retention_days > 0) {
      await expect(
        ctx.storage.audit.cleanup(body.audit_retention_days),
      ).resolves.toBe(0);
      await expect(
        ctx.storage.outboundWebhookDeliveries.cleanup(
          body.audit_retention_days,
        ),
      ).resolves.toBe(0);
      await expect(
        ctx.storage.eventLog.cleanup(body.event_log_retention_hours),
      ).resolves.toBe(0);
      await expect(
        ctx.storage.idempotency.cleanup(body.event_log_retention_hours),
      ).resolves.toBe(0);
    }
    for (const name of [
      "audit-cleanup",
      "event-log-cleanup",
      "trash-purge",
      "inbound-delivery-cleanup",
    ]) {
      const response = await request(
        ctx.app,
        "POST",
        `/housekeeping/${name}/run`,
        { key: ctx.operatorKey },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        name,
        outcome: "ok",
        error: null,
      });
    }
  }
});

it("keeps witnessed expired rows at zero and expires them through the registered jobs at ordinary positive retention", async () => {
  const sqlite = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    __sqliteAll: (sql: string) => Promise<unknown[]>;
  };
  await sqlite.__sqliteRun(
    "INSERT INTO audit_log (id, created_at, action, resource_type) VALUES (?, ?, 'range-witness', 'item')",
    ["retention-witness", "2020-01-01T00:00:00.000Z"],
  );
  await sqlite.__sqliteRun(
    "INSERT INTO event_log (event_type, item_id, payload, enable_fanout, created_at) VALUES ('item.created', 'retention-witness', '{}', 1, ?)",
    ["2020-01-01T00:00:00.000Z"],
  );
  await sqlite.__sqliteRun(
    "INSERT INTO event_log (event_type, item_id, payload, enable_fanout, created_at) VALUES ('item.created', 'retention-head', '{}', 1, ?)",
    [new Date().toISOString()],
  );
  const audit = () =>
    sqlite.__sqliteAll(
      "SELECT id FROM audit_log WHERE id = 'retention-witness'",
    );
  const events = () =>
    sqlite.__sqliteAll(
      "SELECT id FROM event_log WHERE item_id = 'retention-witness'",
    );
  expect(await audit()).toHaveLength(1);
  expect(await events()).toHaveLength(1);
  for (const retention of [0, 1]) {
    expect(
      (
        await request(ctx.app, "PUT", "/config", {
          key: ctx.workingKey,
          body: {
            audit_retention_days: retention,
            event_log_retention_hours: retention,
          },
        })
      ).status,
    ).toBe(200);
    for (const name of ["audit-cleanup", "event-log-cleanup"]) {
      const response = await request(
        ctx.app,
        "POST",
        `/housekeeping/${name}/run`,
        { key: ctx.operatorKey },
      );
      expect(await response.json()).toMatchObject({
        outcome: "ok",
        error: null,
      });
    }
    expect(await audit()).toHaveLength(retention === 0 ? 1 : 0);
    expect(await events()).toHaveLength(retention === 0 ? 1 : 0);
  }
});

it("runs each affected registered job with maximum environment defaults", async () => {
  const maximum = await createTestContext({
    auditRetentionDays: 36500,
    eventLogRetentionHours: 876000,
    trashRetentionDays: 36500,
    revokedGrantRetentionDays: 36500,
    grantInactivityDays: 36500,
    dcrClientRetentionDays: 36500,
    bulkActionJobRetentionMs: 3153600000000,
  });
  try {
    registerHousekeepingJobs(
      maximum.housekeeping,
      maximum.storage,
      maximum.blobs,
      maximum.config,
    );
    await maximum.housekeeping.start();
    expect(maximum.storage.oauthProvider).toBeDefined();
    for (const name of [
      "audit-cleanup",
      "event-log-cleanup",
      "trash-purge",
      "revoked-grant-purge",
      "grant-inactivity-retirement",
      "dcr-client-cleanup",
      "bulk-action-gc",
    ]) {
      const response = await request(
        maximum.app,
        "POST",
        `/housekeeping/${name}/run`,
        { key: maximum.operatorKey },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        name,
        outcome: "ok",
        error: null,
      });
    }
  } finally {
    await maximum.housekeeping.stop();
    await maximum.cleanup();
  }
});
