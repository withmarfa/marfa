import { createServer } from "node:http";
import { once } from "node:events";
import { createWebhookHttpClient } from "./outbound-http.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  seedOauthBearer,
  TEST_API_KEY_SALT,
  request,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { writeInstanceConfig } from "../storage/instance-config.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import {
  WebhookScheduler,
  deliverWebhookAttempt,
  RETRY_DELAYS,
} from "./delivery.js";
let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext({ webhookAllowPrivateAddresses: true });
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  vi.useRealTimers();
  __resetEventLogForTests();
  await ctx.cleanup();
});
async function seed(key = ctx.workingKey) {
  const res = await request(ctx.app, "POST", "/webhooks", {
    key,
    body: { url: "https://receiver.example/hook", events: ["item.created"] },
  });
  const hook = (await res.json()) as { id: string; url: string };
  expect(res.status).toBe(201);
  await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "ordinary retry" } },
  });
  await new WebhookScheduler({
    storage: ctx.storage,
    http: {
      post: () =>
        Promise.resolve({ kind: "answered", status: 400, retryAfter: null }),
    },
  }).runOnce();
  const delivery = (
    await ctx.storage.outboundWebhookDeliveries.list(hook.id, { limit: 10 })
  ).data[0]!;
  return {
    hook,
    delivery,
    path: `/webhooks/${hook.id}/deliveries/${delivery.id}/redeliver`,
  };
}
async function claim(id: string, now = new Date().toISOString()) {
  const row = await ctx.storage.outboundWebhookDeliveries.claimById(
    id,
    new Date(Date.parse(now) + 60000).toISOString(),
    now,
  );
  expect(row).not.toBeNull();
  return row!;
}
describe("failed delivery reopening and claim fencing", () => {
  it("queues the same failed row once, keeps last accepted outcome, and uses current URL", async () => {
    const { hook, delivery, path } = await seed();
    await request(ctx.app, "PATCH", `/webhooks/${hook.id}`, {
      key: ctx.workingKey,
      body: { url: "https://receiver.example/new" },
    });
    const results = await Promise.all([
      request(ctx.app, "POST", path, { key: ctx.workingKey }),
      request(ctx.app, "POST", path, { key: ctx.workingKey }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await results.find((r) => r.status === 202)!.json()).toMatchObject({
      id: delivery.id,
      status: "pending",
      status_code: 400,
      attempt: 1,
      error: "HTTP 400",
    });
    const row = await claim(delivery.id);
    expect(row).toMatchObject({
      event_id: "1",
      retry_start_attempt: 1,
      webhook_url: "https://receiver.example/new",
    });
    expect(row.payload).toContain("ordinary retry");
  });
  it("masks another owner and missing delivery, and refuses success/canceled/nonretained/expired rows", async () => {
    const { hook, delivery, path } = await seed();
    const other = await mintWorkingKey(ctx);
    expect((await request(ctx.app, "POST", path, { key: other })).status).toBe(
      404,
    );
    expect(
      (
        await request(
          ctx.app,
          "POST",
          `/webhooks/${hook.id}/deliveries/missing/redeliver`,
          { key: ctx.workingKey },
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(202);
    const row = await claim(delivery.id);
    await ctx.storage.outboundWebhookDeliveries.markSuccess(
      row.id,
      row.claim_token,
      200,
      2,
    );
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(409);
    const raw = ctx.storage as typeof ctx.storage & {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      "UPDATE outbound_webhook_deliveries SET status='dead_letter',payload=NULL WHERE id=?",
      [delivery.id],
    );
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(409);
    await raw.__sqliteRun(
      "UPDATE outbound_webhook_deliveries SET payload='{}',created_at='2000-01-01T00:00:00.000Z' WHERE id=?",
      [delivery.id],
    );
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(409);
  });
  it("rejects old success, failure and cancellation after controlled expiry and reopened cycle", async () => {
    const { delivery, path } = await seed();
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(202);
    const a = await ctx.storage.outboundWebhookDeliveries.claimById(
      delivery.id,
      "2000-01-01T00:00:01.000Z",
      "9998-01-01T00:00:00.000Z",
    );
    expect(a).not.toBeNull();
    const b = await claim(delivery.id);
    expect(b.claim_token).not.toBe(a!.claim_token);
    expect(
      await ctx.storage.outboundWebhookDeliveries.markFailed(
        b.id,
        b.claim_token,
        400,
        "HTTP 400",
        2,
        null,
      ),
    ).toBe(true);
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(202);
    expect(
      await ctx.storage.outboundWebhookDeliveries.markSuccess(
        a!.id,
        a!.claim_token,
        200,
        2,
      ),
    ).toBe(false);
    expect(
      await ctx.storage.outboundWebhookDeliveries.markFailed(
        a!.id,
        a!.claim_token,
        503,
        "HTTP 503",
        2,
        null,
      ),
    ).toBe(false);
    expect(
      await ctx.storage.outboundWebhookDeliveries.markCanceled(
        a!.id,
        a!.claim_token,
        "old reach",
      ),
    ).toBe(false);
    expect(
      await ctx.storage.outboundWebhookDeliveries.get(b.webhook_id, b.id),
    ).toMatchObject({ status: "pending", status_code: 400, attempt: 2 });
  });
  it("checks effective original retention, inactive state and malformed retained frames", async () => {
    const { hook, delivery, path } = await seed();
    const raw = ctx.storage as typeof ctx.storage & {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    };
    await request(ctx.app, "PATCH", `/webhooks/${hook.id}`, {
      key: ctx.workingKey,
      body: { active: false },
    });
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(409);
    await request(ctx.app, "PATCH", `/webhooks/${hook.id}`, {
      key: ctx.workingKey,
      body: { active: true },
    });
    await writeInstanceConfig(ctx.storage.settings, {
      audit_retention_days: 1,
    });
    await raw.__sqliteRun(
      "UPDATE outbound_webhook_deliveries SET created_at=? WHERE id=?",
      [new Date(Date.now() - 2 * 86400000).toISOString(), delivery.id],
    );
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(409);
    await writeInstanceConfig(ctx.storage.settings, {
      audit_retention_days: 0,
    });
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(202);
    const claimed = await claim(delivery.id);
    await ctx.storage.outboundWebhookDeliveries.markFailed(
      claimed.id,
      claimed.claim_token,
      400,
      "HTTP 400",
      2,
      null,
    );
    await raw.__sqliteRun(
      "UPDATE outbound_webhook_deliveries SET payload=? WHERE id=?",
      ['{"type":"item.created","item":null}', delivery.id],
    );
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(409);
  });
  it("rechecks read reach after reopen and sends nothing when narrowed", async () => {
    const key = await mintWorkingKey(ctx);
    const { hook, delivery, path } = await seed(key);
    expect((await request(ctx.app, "POST", path, { key })).status).toBe(202);
    const owner = (await ctx.storage.outboundWebhooks.get(hook.id))!.owner;
    if (owner.kind !== "key") throw new Error("key fixture missing");
    await ctx.storage.keys.update(owner.keyId, {
      type_permissions: { "core.task": "read" },
    });
    const http = {
      post: vi.fn(() =>
        Promise.resolve({
          kind: "answered" as const,
          status: 200,
          retryAfter: null,
        }),
      ),
    };
    await deliverWebhookAttempt(
      { storage: ctx.storage, http },
      await claim(delivery.id),
      1000,
      false,
    );
    expect(http.post).not.toHaveBeenCalled();
    expect(
      await ctx.storage.outboundWebhookDeliveries.get(hook.id, delivery.id),
    ).toMatchObject({ status: "canceled", attempt: 1, status_code: 400 });
    expect((await request(ctx.app, "POST", path, { key })).status).toBe(409);
  });
  it("belongs to the OAuth grant and refuses its revoked owner", async () => {
    const scopes = ["content:read", "webhooks.manage"];
    const grant = await seedOauthBearer(ctx.storage, scopes);
    const provider = ctx.storage.oauthProvider!;
    const row = await provider.validateAccessToken(
      hashApiKey(grant.token.slice("marfa_at_".length), TEST_API_KEY_SALT),
    );
    expect(row?.userId).toBeTruthy();
    await provider.upsertConsent({
      clientId: grant.clientId,
      authUserId: row!.userId!,
      scopes,
    });
    const { hook, delivery, path } = await seed(grant.token);
    const stranger = await seedOauthBearer(ctx.storage, scopes);
    expect(
      (await request(ctx.app, "POST", path, { key: stranger.token })).status,
    ).toBe(404);
    expect(
      (await request(ctx.app, "POST", path, { key: grant.token })).status,
    ).toBe(202);
    await ctx.storage.outboundWebhookDeliveries.markFailed(
      delivery.id,
      (await claim(delivery.id)).claim_token,
      400,
      "HTTP 400",
      2,
      null,
    );
    await provider.upsertConsent({
      clientId: grant.clientId,
      authUserId: row!.userId!,
      scopes: [],
    });
    expect(
      (await request(ctx.app, "POST", path, { key: grant.token })).status,
    ).not.toBe(202);
    const stored = await ctx.storage.outboundWebhookDeliveries.get(
      hook.id,
      delivery.id,
    );
    expect(stored?.status).toBe("dead_letter");
  });
  it("fences an actual delayed HTTP completion after controlled expiry and reopening", async () => {
    const { hook, delivery, path } = await seed();
    let answer!: () => void;
    let arrived!: () => void;
    const received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        answer = () => {
          res.writeHead(200);
          res.end("owned late response");
        };
        arrived();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("receiver missing");
    let inFlight: Promise<void> | undefined;
    try {
      await request(ctx.app, "PATCH", `/webhooks/${hook.id}`, {
        key: ctx.workingKey,
        body: { url: `http://127.0.0.1:${String(address.port)}/late` },
      });
      expect(
        (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
      ).toBe(202);
      const a = await ctx.storage.outboundWebhookDeliveries.claimById(
        delivery.id,
        "2000-01-01T00:00:01.000Z",
        "9998-01-01T00:00:00.000Z",
      );
      expect(a).not.toBeNull();
      inFlight = deliverWebhookAttempt(
        {
          storage: ctx.storage,
          http: createWebhookHttpClient({ allowPrivateAddresses: true }),
        },
        a!,
        5000,
        false,
      );
      await received;
      const b = await claim(delivery.id);
      expect(
        await ctx.storage.outboundWebhookDeliveries.markFailed(
          b.id,
          b.claim_token,
          400,
          "HTTP 400",
          2,
          null,
        ),
      ).toBe(true);
      expect(
        (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
      ).toBe(202);
      answer();
      await inFlight;
      expect(
        await ctx.storage.outboundWebhookDeliveries.get(hook.id, delivery.id),
      ).toMatchObject({
        status: "pending",
        status_code: 400,
        attempt: 2,
        error: "HTTP 400",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      await inFlight;
    }
  });
  it("uses eight accepted outcomes per reopened cycle and short Retry-After cannot shrink backoff", async () => {
    const { delivery, path } = await seed();
    expect(
      (await request(ctx.app, "POST", path, { key: ctx.workingKey })).status,
    ).toBe(202);
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = Date.now();
    vi.setSystemTime(now);
    expect(RETRY_DELAYS.reduce((a, b) => a + b, 0)).toBe(19531000);
    for (let ordinal = 2; ordinal <= 9; ordinal++) {
      const row = await claim(delivery.id, new Date(now).toISOString());
      await deliverWebhookAttempt(
        {
          storage: ctx.storage,
          http: {
            post: () =>
              Promise.resolve({
                kind: "answered",
                status: 503,
                retryAfter: "1",
              }),
          },
        },
        row,
        1000,
        false,
      );
      const state = await ctx.storage.outboundWebhookDeliveries.get(
        row.webhook_id,
        row.id,
      );
      expect(state?.attempt).toBe(ordinal);
      if (ordinal < 9) {
        const due = (
          await (
            ctx.storage as typeof ctx.storage & {
              __sqliteAll(sql: string): Promise<{ next_attempt_at: string }[]>;
            }
          ).__sqliteAll(
            `SELECT next_attempt_at FROM outbound_webhook_deliveries WHERE id='${row.id}'`,
          )
        )[0]!.next_attempt_at;
        expect(Date.parse(due) - now).toBe(RETRY_DELAYS[ordinal - 2]);
        now = Date.parse(due);
        vi.setSystemTime(now);
      } else expect(state?.status).toBe("dead_letter");
    }
  });
});
