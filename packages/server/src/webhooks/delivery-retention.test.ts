import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { Housekeeping } from "../housekeeping/scheduler.js";
import { registerHousekeepingJobs } from "../housekeeping/registrations.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const DAY_MS = 86_400_000;

function raw(): {
  all: (query: string) => Promise<unknown[]>;
  run: (query: string, params: unknown[]) => Promise<unknown>;
} {
  const storage = ctx.storage as unknown as {
    __sqliteAll: (query: string) => Promise<unknown[]>;
    __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
  };
  return { all: storage.__sqliteAll, run: storage.__sqliteRun };
}

async function schedule(
  webhookId: string,
  nextAttemptAt = new Date().toISOString(),
): Promise<string> {
  return ctx.storage.outboundWebhookDeliveries.schedule({
    webhookId,
    eventType: "item.created",
    payload: '{"event_type":"item.created"}',
    webhookUrl: "https://example.com/hook",
    webhookSecret: "a".repeat(64),
    nextAttemptAt,
  });
}

async function age(id: string, days: number): Promise<void> {
  await raw().run(
    "UPDATE outbound_webhook_deliveries SET created_at = ? WHERE id = ?",
    [new Date(Date.now() - days * DAY_MS).toISOString(), id],
  );
}

async function runAuditCleanup(): Promise<void> {
  const housekeeping = new Housekeeping(ctx.storage.housekeeping, {
    pollIntervalMs: 3_600_000,
  });
  registerHousekeepingJobs(housekeeping, ctx.storage, ctx.blobs, ctx.config);
  await housekeeping.start();
  try {
    const ran = await housekeeping.runNow("audit-cleanup");
    expect(ran.kind).toBe("ran");
  } finally {
    await housekeeping.stop();
  }
}

describe("outbound delivery history", () => {
  it("leaves with the audit retention, and a delivery still retrying stays", async () => {
    const webhookId = "retention-subscription";
    const succeeded = await schedule(webhookId);
    await ctx.storage.outboundWebhookDeliveries.markSuccess(succeeded, 200, 1);
    const deadLettered = await schedule(webhookId);
    await ctx.storage.outboundWebhookDeliveries.markFailed(
      deadLettered,
      410,
      "gone",
      1,
      null,
    );
    const retrying = await schedule(
      webhookId,
      new Date(Date.now() + DAY_MS).toISOString(),
    );
    const recent = await schedule(webhookId);
    await ctx.storage.outboundWebhookDeliveries.markSuccess(recent, 200, 1);
    for (const id of [succeeded, deadLettered, retrying]) {
      await age(id, ctx.config.auditRetentionDays + 1);
    }

    const before = await ctx.storage.outboundWebhookDeliveries.list(webhookId, {
      limit: 50,
    });
    expect(before.data.map((d) => d.id).sort()).toEqual(
      [succeeded, deadLettered, retrying, recent].sort(),
    );

    await runAuditCleanup();

    const after = await ctx.storage.outboundWebhookDeliveries.list(webhookId, {
      limit: 50,
    });
    expect(after.data.map((d) => d.id).sort()).toEqual(
      [retrying, recent].sort(),
    );
  });

  it("keeps no payload, address or secret once a delivery is settled", async () => {
    const webhookId = "settled-subscription";
    const succeeded = await schedule(webhookId);
    await ctx.storage.outboundWebhookDeliveries.markSuccess(succeeded, 200, 1);
    const failedOut = await schedule(webhookId);
    await ctx.storage.outboundWebhookDeliveries.markFailed(
      failedOut,
      500,
      "server error",
      4,
      null,
    );
    const deadLettered = await schedule(webhookId);
    await ctx.storage.outboundWebhookDeliveries.markDeadLetter(deadLettered);
    const retrying = await schedule(
      webhookId,
      new Date(Date.now() + DAY_MS).toISOString(),
    );

    const rows = (await raw().all(
      `SELECT id, payload, webhook_url, webhook_secret FROM outbound_webhook_deliveries WHERE webhook_id = '${webhookId}'`,
    )) as {
      id: string;
      payload: string | null;
      webhook_url: string | null;
      webhook_secret: string | null;
    }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(retrying)).toMatchObject({
      payload: '{"event_type":"item.created"}',
      webhook_url: "https://example.com/hook",
      webhook_secret: "a".repeat(64),
    });
    for (const id of [succeeded, failedOut, deadLettered]) {
      expect(byId.get(id)).toMatchObject({
        payload: null,
        webhook_url: null,
        webhook_secret: null,
      });
    }
  });
});
