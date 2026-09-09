import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";
import type { CreatedInboundWebhook, InboundWebhook } from "@withmarfa/shared";

let ctx: TestContext;
/** Registered system.integration id pointing at VALID_MANIFEST. Resolved
 *  once at suite setup; every connection in this file references it. */
let integrationId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  // Subscriptions resolve the manifest from the connection's
  // integration_ref → system.integration item. Register one up front so
  // every test connection points at a real id.
  const reg = await request(ctx.app, "POST", "/integrations", {
    key: ctx.operatorKey,
    body: { manifest: VALID_MANIFEST },
  });
  if (reg.status !== 201) {
    throw new Error(
      `inbound-webhooks test setup: integration register failed (${String(reg.status)})`,
    );
  }
  const regBody = (await reg.json()) as { id: string };
  integrationId = regBody.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_MANIFEST = {
  name: "acme/calendar-sync",
  version: "1.0.0",
  publisher: "acme",
  description: "Calendar sync",
  direction: "both" as const,
  triggers: [{ type: "webhook" as const }],
  target_types: ["core.event"],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "prompt-user" as const,
    partial_write_mode: "all-or-nothing" as const,
  },
  webhook_verification: { method: "hmac-sha256" as const },
  manifest_schema_version: "2.0.0",
};

interface ItemResponse {
  item: { id: string; type: string };
}

// Written through storage rather than `POST /items`, because neither
// credential can do this over the wire: the reserved namespace admits only a
// platform credential, and that one holds no space to put the row in. A
// connection is the install pipeline's to create, and it names the space.
async function createConnection(refOverride?: string): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: refOverride ?? integrationId,
      },
    },
    ctx.spaceId,
  );
  return item.id;
}

async function createSubscription(
  connectionId: string,
  events: string[] = ["thing.created"],
): Promise<CreatedInboundWebhook> {
  const res = await request(
    ctx.app,
    "POST",
    `/connections/${connectionId}/inbound-webhooks`,
    {
      key: ctx.spaceKey,
      body: { events },
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

  it("rejects when the manifest declares no webhook_verification", async () => {
    // The route used to read `webhook_verification.method` unconditionally,
    // and every manifest supplied one because the schema demanded it. So a
    // subscription could be registered against an integration with no webhook
    // trigger at all, verified by a method its author never chose, for
    // deliveries that would never arrive. A manifest that declares none is
    // now told so rather than handed a convention.
    const bare = { ...VALID_MANIFEST, name: "acme/no-verification" } as Record<
      string,
      unknown
    >;
    delete bare.webhook_verification;
    delete bare.triggers;
    bare.runs_on = "client";
    const regRes = await request(ctx.app, "POST", "/integrations", {
      key: ctx.operatorKey,
      body: { manifest: bare },
    });
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { id: string };

    const connectionId = await createConnection(reg.id);
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      { key: ctx.spaceKey, body: { events: ["thing.created"] } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("declares no webhook_verification");
  });

  it("rejects when the connection has no integration_ref", async () => {
    // Create a connection with NO integration_ref — the route refuses
    // with MISSING_REQUIRED_FIELD; there is no inline manifest fallback.
    const orphanRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
    });
    const orphan = (await orphanRes.json()) as ItemResponse;
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${orphan.item.id}/inbound-webhooks`,
      {
        key: ctx.spaceKey,
        body: { events: ["thing.created"] },
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_required_field");
  });

  it("rejects when integration_ref doesn't resolve", async () => {
    const orphanRefId = "0192abcd-ef00-7000-8000-000000000099";
    const connectionId = await createConnection(orphanRefId);
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      {
        key: ctx.spaceKey,
        body: { events: ["thing.created"] },
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
        key: ctx.spaceKey,
        body: { events: ["x"] },
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
      { body: { events: ["x"] } },
    );
    expect(res.status).toBe(401);
  });

  it("rejects the 'custom' verification method at registration time", async () => {
    // The manifest comes from the registered integration, so the
    // rejection happens at /integrations registration. Verify that
    // path here so the regression watch stays in this file's scope.
    const res = await request(ctx.app, "POST", "/integrations", {
      key: ctx.operatorKey,
      body: {
        manifest: {
          ...VALID_MANIFEST,
          name: "acme/custom-rejected",
          webhook_verification: {
            method: "custom",
            adapter_id: "acme-internal",
          },
        },
      },
    });
    expect(res.status).toBe(400);
  });

  it("creates a subscription via integration_ref without inline manifest", async () => {
    // 1. Register an Integration via the registry.
    const regRes = await request(ctx.app, "POST", "/integrations", {
      key: ctx.operatorKey,
      body: { manifest: { ...VALID_MANIFEST, name: "acme/via-ref" } },
    });
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { id: string };

    // 2. Create a connection bound to the registered integration.
    const conn = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "integration",
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
        key: ctx.spaceKey,
        body: { events: ["thing.created"] },
      },
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedInboundWebhook;
    expect(created.verification_method).toBe("hmac-sha256");
  });
});

describe("POST /connections/:id/inbound-webhooks — space scoping", () => {
  // The two halves of one invariant: a space-bound key holding
  // `space.connections` must be able to subscribe against a
  // platform-scoped (space_id IS NULL) integration item, and whoever
  // creates the subscription, the row must land in the
  // CONNECTION's space — the local substrate's receipt route looks
  // subscriptions up fenced on the connection's space, so a row stamped
  // with the caller's (absent) space is a subscription that never
  // delivers.
  async function spaceScopedConnection(): Promise<{
    spaceId: string;
    spaceKey: string;
    connectionId: string;
  }> {
    if (!ctx.storage.spaces) {
      throw new Error("space-scoping tests need a spaces store");
    }
    const space = await ctx.storage.spaces.create(
      `inbound-scope-${Math.random().toString(36).slice(2, 8)}`,
    );
    const suffix = Math.random().toString(36).slice(2, 8);
    const rawKey = `marfa_k1_test_spacekey_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `inbound-scope-spacekey-${suffix}`,
        source: `inbound-scope-spacekey-${suffix}`,
        space_permissions: ["space.connections"],
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(rawKey, TEST_API_KEY_SALT),
      space.id,
    );
    // Install through the route so the connection lands in the caller's
    // space with the platform-scoped integration as its integration_ref.
    const install = await request(ctx.app, "POST", "/connections/install", {
      key: rawKey,
      body: { integration_id: integrationId },
    });
    if (install.status !== 201) {
      throw new Error(
        `space-scoped install failed: ${String(install.status)} ${await install.text()}`,
      );
    }
    const body = (await install.json()) as { connection_id: string };
    return {
      spaceId: space.id,
      spaceKey: rawKey,
      connectionId: body.connection_id,
    };
  }

  it("a space key holding space.connections subscribes against a platform-scoped integration item", async () => {
    const { spaceId, spaceKey, connectionId } = await spaceScopedConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      { key: spaceKey, body: { events: ["thing.created"] } },
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedInboundWebhook;
    expect(created.space_id).toBe(spaceId);
  });

  it("an operator key's create stamps the connection's space, not its own", async () => {
    const { spaceId, connectionId } = await spaceScopedConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      { key: ctx.spaceKey, body: { events: ["thing.created"] } },
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedInboundWebhook;
    expect(created.space_id).toBe(spaceId);
    // The receipt route's fenced lookup must find the row.
    const rows = await ctx.storage.inboundWebhooks.listByConnection(
      connectionId,
      spaceId,
    );
    expect(rows.map((r) => r.id)).toContain(created.id);
  });

  it("a space key from another space cannot reach the connection", async () => {
    // The fence on the connection lookup is what makes stamping the
    // connection's space safe: a caller only ever reaches connections
    // whose space it shares, so the stamp cannot cross a boundary.
    const { connectionId } = await spaceScopedConnection();
    const { spaceKey: otherSpaceKey } = await spaceScopedConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      { key: otherSpaceKey, body: { events: ["thing.created"] } },
    );
    expect(res.status).toBe(404);
    // The error code pins WHICH fence refused: connection_not_found is
    // requireConnectionAccess's own lookup, not the manifest resolver's
    // downstream not_found — the property is double-fenced and this
    // asserts the primary layer.
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("connection_not_found");
  });
});

describe("GET /connections/:id/inbound-webhooks", () => {
  it("lists subscriptions with secrets redacted", async () => {
    const connectionId = await createConnection();
    await createSubscription(connectionId);
    await createSubscription(connectionId, ["thing.updated"]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks`,
      { key: ctx.spaceKey },
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
      "X-Marfa-Signature": `sha256=${sig}`,
      "X-Marfa-Delivery-Id": "delivery-1",
    });
    expect(res.status).toBe(200);
  });

  it("idempotent on duplicate external_delivery_id — 200 ack, no duplicate row", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    const body = '{"event":"thing.created"}';
    const sig = hmacHex(sub.secret, body);
    const headers = {
      "X-Marfa-Signature": `sha256=${sig}`,
      "X-Marfa-Delivery-Id": "delivery-dup",
    };
    const first = await postRaw(`/webhooks/inbound/${sub.id}`, body, headers);
    const second = await postRaw(`/webhooks/inbound/${sub.id}`, body, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries`,
      { key: ctx.spaceKey },
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
      "X-Marfa-Signature": `sha256=${sig}`,
      "X-Marfa-Delivery-Id": "delivery-tampered",
    });
    expect(res.status).toBe(401);

    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries`,
      { key: ctx.spaceKey },
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
      { "X-Marfa-Signature": "sha256=00" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 410 for a disabled subscription", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    // Disable directly via storage — no PATCH route exposed.
    await ctx.storage.inboundWebhooks.setDisabled(sub.id, true);

    const body = '{"x":1}';
    const sig = hmacHex(sub.secret, body);
    const res = await postRaw(`/webhooks/inbound/${sub.id}`, body, {
      "X-Marfa-Signature": `sha256=${sig}`,
    });
    expect(res.status).toBe(410);
  });

  it("verified=true row leaves processed_at NULL (pending dispatch)", async () => {
    const connectionId = await createConnection();
    const sub = await createSubscription(connectionId);
    const body = '{"event":"x"}';
    const sig = hmacHex(sub.secret, body);
    const res = await postRaw(`/webhooks/inbound/${sub.id}`, body, {
      "X-Marfa-Signature": `sha256=${sig}`,
      "X-Marfa-Delivery-Id": "delivery-pending",
    });
    expect(res.status).toBe(200);

    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries`,
      { key: ctx.spaceKey },
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
      "X-Marfa-Signature": `sha256=${sig}`,
      "X-Marfa-Delivery-Id": "delivery-for-retry",
    });

    // Manually mark the row as DLQ via storage to simulate exhausted retries.
    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/inbound-webhooks/${sub.id}/deliveries`,
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The credential a running integration actually holds
// ---------------------------------------------------------------------------

/**
 * This route admits a Connection acting on itself as an alternative to
 * `space.connections`, and the shape that reaches it in production is a
 * runtime credential rather than a credential holding the permission.
 * Nothing here covered that, so the identity arm of the gate was carried
 * entirely by the proxy and leased-token suites while this route shared the
 * predicate with them.
 *
 * Minted through the real path rather than hand-built: a fixture given
 * a `source` of the author's choosing can satisfy a gate that reads
 * one, which is how a gate came to admit only a credential no caller
 * could present.
 */
describe("inbound webhooks — integration runtime credential", () => {
  it("creates a subscription with the connection's own runtime credential", async () => {
    const connectionId = await createConnection();
    const credential = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/inbound-webhooks`,
      {
        key: credential.api_key,
        body: { events: ["thing.created"] },
      },
    );
    expect(res.status).toBe(201);
  });

  it("refuses a runtime credential bound to a different connection", async () => {
    const connectionA = await createConnection();
    const connectionB = await createConnection();
    const credential = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionA,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionB}/inbound-webhooks`,
      {
        key: credential.api_key,
        body: { events: ["thing.created"] },
      },
    );
    expect(res.status).toBe(403);
  });
});
