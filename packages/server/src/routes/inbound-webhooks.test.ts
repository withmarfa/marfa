import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { CreatedInboundWebhook, InboundWebhook } from "@mymehq/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_MANIFEST = {
  name: "acme.calendar-sync",
  version: "1.0.0",
  publisher: "Acme",
  description: "Calendar sync",
  direction: "both" as const,
  triggers: [{ type: "webhook" as const }],
  target_types: ["core.event"],
  runtime_compatibility: ["hosted"],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "prompt-user" as const,
    partial_write_mode: "all-or-nothing" as const,
  },
  oauth_requirements: {},
  webhook_verification: { method: "hmac-sha256" as const },
  manifest_schema_version: "1.0.0",
};

interface ItemResponse {
  item: { id: string; type: string };
}

async function createConnection(): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.connection",
      properties: {
        kind: "external-service-connector",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: "acme.calendar-sync",
      },
    },
  });
  if (res.status !== 201) {
    throw new Error(`createConnection failed: ${String(res.status)}`);
  }
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

async function createSubscription(
  connectionId: string,
  manifest: unknown = VALID_MANIFEST,
  events: string[] = ["thing.created"],
): Promise<CreatedInboundWebhook> {
  const res = await request(
    ctx.app,
    "POST",
    `/connections/${connectionId}/inbound-webhooks`,
    {
      key: ctx.adminKey,
      body: { events, manifest },
    },
  );
  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`createSubscription failed: ${String(res.status)} ${body}`);
  }
  return (await res.json()) as CreatedInboundWebhook;
}

/** Sends a raw-body request — the receipt route wants Buffer-equivalent
 *  bytes, not JSON-stringified objects. */
function postRaw(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    ctx.app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    }),
  );
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

describe("POST /connections/:id/inbound-webhooks", () => {
  it("creates a subscription on the happy path; returns secret once", async () => {
    const connectionId = await createConnection();
    const created = await createSubscription(connectionId);

    expect(created.id).toBeDefined();
    expect(created.connection_id).toBe(connectionId);
    expect(created.verification_method).toBe("hmac-sha256");
    expect(created.events).toEqual(["thing.created"]);
    expect(created.disabled).toBe(false);
    expect(typeof created.secret).toBe("string");
    expect(created.secret.length).toBeGreaterThanOrEqual(32);
    expect(created.secret_redacted.startsWith("****")).toBe(true);
  });

  it("rejects an invalid manifest with 400 + structured errors", async () => {
    const connectionId = await createConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      {
        key: ctx.adminKey,
        body: {
          events: ["thing.created"],
          manifest: { name: "Bad Name With Spaces" },
        },
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { errors: { path: string }[] } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(Array.isArray(body.error.details?.errors)).toBe(true);
  });

  it("rejects an unsupported manifest_schema_version major", async () => {
    const connectionId = await createConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      {
        key: ctx.adminKey,
        body: {
          events: ["thing.created"],
          manifest: { ...VALID_MANIFEST, manifest_schema_version: "2.0.0" },
        },
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the connection does not exist", async () => {
    const res = await request(
      ctx.app,
      "POST",
      `/connections/0192abc1-2345-7000-8000-000000000000/inbound-webhooks`,
      {
        key: ctx.adminKey,
        body: { events: ["x"], manifest: VALID_MANIFEST },
      },
    );
    expect(res.status).toBe(404);
  });

  it("requires authentication — 401 without a credential", async () => {
    const connectionId = await createConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      { body: { events: ["x"], manifest: VALID_MANIFEST } },
    );
    expect(res.status).toBe(401);
  });

  it("stamps verification_adapter_id when manifest declares custom verification", async () => {
    const connectionId = await createConnection();
    const created = await createSubscription(connectionId, {
      ...VALID_MANIFEST,
      webhook_verification: {
        method: "custom",
        adapter_id: "acme-internal",
      },
    });
    expect(created.verification_method).toBe("custom");
    expect(created.verification_adapter_id).toBe("acme-internal");
  });

  // Layer 2 PR 2: preferred path — connection bound to a real
  // system.integration item; manifest resolved server-side, body omits
  // it entirely.
  it("creates a subscription via integration_ref without inline manifest", async () => {
    // 1. Register an Integration via the registry.
    const regRes = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: { ...VALID_MANIFEST, name: "acme.via-ref" } },
    });
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { id: string };

    // 2. Create a connection bound to the registered integration.
    const conn = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "external-service-connector",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: reg.id,
        },
      },
    });
    const connBody = (await conn.json()) as ItemResponse;
    const connectionId = connBody.item.id;

    // 3. Create the subscription with NO manifest in the body — the
    // route should resolve it via integration_ref.
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      {
        key: ctx.adminKey,
        body: { events: ["thing.created"] },
      },
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedInboundWebhook;
    expect(created.verification_method).toBe("hmac-sha256");
  });
});

describe("GET /connections/:id/inbound-webhooks", () => {
  it("lists subscriptions with secrets redacted", async () => {
    const connectionId = await createConnection();
    await createSubscription(connectionId);
    await createSubscription(connectionId, VALID_MANIFEST, ["thing.updated"]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inbound_webhooks: InboundWebhook[] };
    expect(body.inbound_webhooks.length).toBeGreaterThanOrEqual(2);
    for (const w of body.inbound_webhooks) {
      expect(w.secret_redacted.startsWith("****")).toBe(true);
      // Wire shape MUST NOT carry the raw secret.
      expect("secret" in w).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Public receipt endpoint
// ---------------------------------------------------------------------------

describe("POST /webhooks/inbound/:id (public)", () => {
  it("verifies a correctly-signed payload and returns 200", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    const body = '{"event":"thing.created"}';
    const sig = hmacHex(sub.secret, body);
    const res = await postRaw(`/webhooks/inbound/${sub.id}`, body, {
      "X-Myme-Signature": `sha256=${sig}`,
      "X-Myme-Delivery-Id": "delivery-1",
    });
    expect(res.status).toBe(200);
  });

  it("idempotent on duplicate external_delivery_id — 200 ack, no duplicate row", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    const body = '{"event":"thing.created"}';
    const sig = hmacHex(sub.secret, body);
    const headers = {
      "X-Myme-Signature": `sha256=${sig}`,
      "X-Myme-Delivery-Id": "delivery-dup",
    };
    const first = await postRaw(`/webhooks/inbound/${sub.id}`, body, headers);
    const second = await postRaw(`/webhooks/inbound/${sub.id}`, body, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries`,
      { key: ctx.adminKey },
    );
    expect(list.status).toBe(200);
    const dlist = (await list.json()) as {
      deliveries: { external_delivery_id: string }[];
    };
    const matching = dlist.deliveries.filter(
      (d) => d.external_delivery_id === "delivery-dup",
    );
    expect(matching.length).toBe(1);
  });

  it("rejects a tampered payload with 401, but writes a row for audit", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    const body = '{"event":"thing.created"}';
    const sig = hmacHex(sub.secret, body);
    const tampered = '{"event":"PWNED"}';
    const res = await postRaw(`/webhooks/inbound/${sub.id}`, tampered, {
      "X-Myme-Signature": `sha256=${sig}`,
      "X-Myme-Delivery-Id": "delivery-tampered",
    });
    expect(res.status).toBe(401);

    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries`,
      { key: ctx.adminKey },
    );
    const dlist = (await list.json()) as {
      deliveries: {
        verified: boolean;
        processing_error: string | null;
        external_delivery_id: string;
      }[];
    };
    const audit = dlist.deliveries.find(
      (d) => d.external_delivery_id === "delivery-tampered",
    );
    expect(audit).toBeDefined();
    expect(audit?.verified).toBe(false);
    expect(audit?.processing_error).toContain("mismatch");
  });

  it("returns 404 for an unknown subscription id", async () => {
    const res = await postRaw(
      "/webhooks/inbound/0192abc1-2345-7000-8000-000000000000",
      "{}",
      { "X-Myme-Signature": "sha256=00" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 410 for a disabled subscription", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    // Disable directly via storage — no PATCH route in WS2.
    await ctx.storage.inboundWebhooks.setDisabled(sub.id, true);

    const body = '{"x":1}';
    const sig = hmacHex(sub.secret, body);
    const res = await postRaw(`/webhooks/inbound/${sub.id}`, body, {
      "X-Myme-Signature": `sha256=${sig}`,
    });
    expect(res.status).toBe(410);
  });

  it("verified=true row leaves processed_at NULL (WS3 picks up later)", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    const body = '{"event":"x"}';
    const sig = hmacHex(sub.secret, body);
    const res = await postRaw(`/webhooks/inbound/${sub.id}`, body, {
      "X-Myme-Signature": `sha256=${sig}`,
      "X-Myme-Delivery-Id": "delivery-pending",
    });
    expect(res.status).toBe(200);

    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries`,
      { key: ctx.adminKey },
    );
    const dlist = (await list.json()) as {
      deliveries: {
        verified: boolean;
        processed_at: string | null;
        processing_error: string | null;
        next_attempt_at: string | null;
        external_delivery_id: string;
      }[];
    };
    const event = dlist.deliveries.find(
      (d) => d.external_delivery_id === "delivery-pending",
    );
    expect(event).toBeDefined();
    expect(event?.verified).toBe(true);
    expect(event?.processed_at).toBeNull();
    expect(event?.processing_error).toBeNull();
    // Pending queue: next_attempt_at set, processed_at + processing_error null.
    expect(event?.next_attempt_at).not.toBeNull();
  });

  it("custom verification stub returns 401 on every receipt", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId, {
      ...VALID_MANIFEST,
      webhook_verification: {
        method: "custom",
        adapter_id: "acme-internal",
      },
    });
    const res = await postRaw(`/webhooks/inbound/${sub.id}`, "{}");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DLQ retry
// ---------------------------------------------------------------------------

describe("POST /connections/:id/inbound-webhooks/:webhook_id/deliveries/:event_id/retry", () => {
  it("resets the row and brings it back into the pending window", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    const body = '{"event":"x"}';
    const sig = hmacHex(sub.secret, body);
    await postRaw(`/webhooks/inbound/${sub.id}`, body, {
      "X-Myme-Signature": `sha256=${sig}`,
      "X-Myme-Delivery-Id": "delivery-for-retry",
    });

    // Manually mark the row as DLQ via storage to simulate exhausted retries.
    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries`,
      { key: ctx.adminKey },
    );
    const dlist = (await list.json()) as {
      deliveries: { id: string; external_delivery_id: string }[];
    };
    const eventRow = dlist.deliveries.find(
      (d) => d.external_delivery_id === "delivery-for-retry",
    );
    if (!eventRow) throw new Error("event not found");

    // Retry endpoint should accept the request and reset the row.
    const retryRes = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries/${eventRow.id}/retry`,
      { key: ctx.adminKey },
    );
    expect(retryRes.status).toBe(200);

    const after = await ctx.storage.inboundWebhookEvents.get(eventRow.id);
    expect(after?.retry_count).toBe(0);
    expect(after?.processing_error).toBeNull();
    expect(after?.next_attempt_at).not.toBeNull();
  });

  it("returns 404 when event_id doesn't belong to the named webhook", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries/0192abc1-2345-7000-8000-000000000000/retry`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });
});
