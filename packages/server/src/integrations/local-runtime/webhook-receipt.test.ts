/**
 * Webhook receipt route (POST /runtime/webhook/:connection_id) — the
 * integration runtime's inbound webhook endpoint. Covers:
 *
 *   - verify happy path enqueues a WebhookMessage
 *   - duplicate delivery short-circuits to 200 + duplicate: true
 *   - signature mismatch returns 401
 *   - revoked Connection returns 410
 *   - connection without subscriptions returns 404
 */
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { encryptSecret, SECRET_INFO } from "../../crypto/secret-encryption.js";
import { registerWebhookReceiptRoute } from "./webhook-receipt.js";
import type { LocalRuntime, SchedulerEnvelope } from "./types.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const MANIFEST = {
  name: "test/webhook-receipt",
  version: "0.0.1",
  publisher: "test",
  description: "Webhook receipt test",
  manifest_schema_version: "1.0.0",
  direction: "read" as const,
  runtime_compatibility: ["local"],
  target_types: ["core.note"],
  triggers: [{ type: "webhook" as const }],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "all-or-nothing",
  },
  oauth_requirements: {},
  webhook_verification: { method: "hmac-sha256" as const },
};

interface TestSetup {
  app: Hono;
  enqueued: SchedulerEnvelope[];
  connectionId: string;
  secret: string;
  subscriptionId: string;
}

async function setupConnection(): Promise<TestSetup> {
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: MANIFEST.name,
        manifest_version: MANIFEST.version,
        publisher: MANIFEST.publisher,
        manifest: MANIFEST,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const conn = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        integration_ref: integration.id,
        granted_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const secret = "test-secret-" + Math.random().toString(36).slice(2, 10);
  const sub = await ctx.storage.inboundWebhooks.create({
    id: `inb_${Math.random().toString(36).slice(2, 14)}`,
    connection_id: conn.id,
    secret_encrypted: encryptSecret(secret, SECRET_INFO.inboundWebhookSecret),
    verification_method: "hmac-sha256",
    events: ["*"],
  });

  const enqueued: SchedulerEnvelope[] = [];
  const runtime: LocalRuntime = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    enqueue: (e) => {
      enqueued.push(e);
      return Promise.resolve();
    },
    dispatchForTest: () => Promise.resolve({ ok: true }),
    getRegistration: () => undefined,
  };
  const app = new Hono();
  registerWebhookReceiptRoute(app, ctx.storage, runtime);
  return {
    app,
    enqueued,
    connectionId: conn.id,
    secret,
    subscriptionId: sub.id,
  };
}

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("POST /runtime/webhook/:connection_id", () => {
  it("verifies the HMAC and enqueues a WebhookMessage", async () => {
    const setup = await setupConnection();
    const body = JSON.stringify({ hello: "world" });
    const signature = signBody(body, setup.secret);

    const res = await setup.app.request(
      `/runtime/webhook/${setup.connectionId}`,
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-marfa-signature": `sha256=${signature}`,
          "x-marfa-delivery-id": "delivery_test_1",
        },
      },
    );
    expect(res.status).toBe(202);
    const payload = (await res.json()) as { ok: boolean; delivery_id: string };
    expect(payload.ok).toBe(true);
    expect(payload.delivery_id).toBe("delivery_test_1");
    expect(setup.enqueued).toHaveLength(1);
    const enqueued = setup.enqueued[0];
    expect(enqueued?.integration_name).toBe(MANIFEST.name);
    expect(enqueued?.message.kind).toBe("webhook");
    expect(enqueued?.message.connection_id).toBe(setup.connectionId);
  });

  it("returns duplicate:true on a redelivered (subscription, delivery_id) pair", async () => {
    const setup = await setupConnection();
    const body = JSON.stringify({ id: "abc" });
    const signature = signBody(body, setup.secret);
    const headers = {
      "content-type": "application/json",
      "x-marfa-signature": `sha256=${signature}`,
      "x-marfa-delivery-id": "delivery_dup",
    };
    const first = await setup.app.request(
      `/runtime/webhook/${setup.connectionId}`,
      { method: "POST", body, headers },
    );
    expect(first.status).toBe(202);
    const second = await setup.app.request(
      `/runtime/webhook/${setup.connectionId}`,
      { method: "POST", body, headers },
    );
    expect(second.status).toBe(200);
    const payload = (await second.json()) as { duplicate?: boolean };
    expect(payload.duplicate).toBe(true);
    expect(setup.enqueued).toHaveLength(1);
  });

  it("returns 401 on a signature mismatch", async () => {
    const setup = await setupConnection();
    const body = JSON.stringify({ x: 1 });
    const badSignature = signBody(body, "wrong-secret");
    const res = await setup.app.request(
      `/runtime/webhook/${setup.connectionId}`,
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-marfa-signature": `sha256=${badSignature}`,
        },
      },
    );
    expect(res.status).toBe(401);
    expect(setup.enqueued).toHaveLength(0);
  });

  it("returns 410 for a revoked Connection", async () => {
    const setup = await setupConnection();
    await ctx.storage.items.transition(
      setup.connectionId,
      "revoked",
      undefined,
    );
    const body = "{}";
    const res = await setup.app.request(
      `/runtime/webhook/${setup.connectionId}`,
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-marfa-signature": `sha256=${signBody(body, setup.secret)}`,
        },
      },
    );
    expect(res.status).toBe(410);
    expect(setup.enqueued).toHaveLength(0);
  });

  it("refuses a paused Connection with a retryable 503, burning no idempotency slot", async () => {
    // Accepting-and-dropping would record the sender's delivery id and
    // swallow their redelivery as a duplicate — the event gone, not
    // deferred. The 503 keeps the sender's retry schedule in charge:
    // the same delivery lands cleanly once the connection resumes.
    const setup = await setupConnection();
    const row = await ctx.storage.items.get(setup.connectionId);
    await ctx.storage.items.update(setup.connectionId, {
      properties: { ...row!.properties, runtime_status: "paused" },
    });

    const body = JSON.stringify({ delivery: "paused-window" });
    const headers = {
      "content-type": "application/json",
      "x-marfa-signature": `sha256=${signBody(body, setup.secret)}`,
      "x-delivery-id": "paused-delivery-1",
    };
    const refused = await setup.app.request(
      `/runtime/webhook/${setup.connectionId}`,
      { method: "POST", body, headers },
    );
    expect(refused.status).toBe(503);
    expect(setup.enqueued).toHaveLength(0);

    // Resume, then the sender's redelivery of the SAME delivery id must
    // land as a fresh delivery, not a duplicate.
    const paused = await ctx.storage.items.get(setup.connectionId);
    await ctx.storage.items.update(setup.connectionId, {
      properties: { ...paused!.properties, runtime_status: "healthy" },
    });
    const landed = await setup.app.request(
      `/runtime/webhook/${setup.connectionId}`,
      { method: "POST", body, headers },
    );
    expect(landed.status).toBe(202);
    const landedBody = (await landed.json()) as { duplicate?: boolean };
    expect(landedBody.duplicate ?? false).toBe(false);
    expect(setup.enqueued).toHaveLength(1);
  });

  it("returns 404 when the Connection has no inbound subscriptions", async () => {
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: MANIFEST.name,
          manifest_version: MANIFEST.version,
          publisher: MANIFEST.publisher,
          manifest: MANIFEST,
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const conn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          integration_ref: integration.id,
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const enqueued: SchedulerEnvelope[] = [];
    const runtime: LocalRuntime = {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      enqueue: (e) => {
        enqueued.push(e);
        return Promise.resolve();
      },
      dispatchForTest: () => Promise.resolve({ ok: true }),
      getRegistration: () => undefined,
    };
    const app = new Hono();
    registerWebhookReceiptRoute(app, ctx.storage, runtime);
    const res = await app.request(`/runtime/webhook/${conn.id}`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
  });
});
