import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface RuntimeCredentialResponse {
  id: string;
  api_key: string;
  connection_id: string;
  label: string;
  source: string;
  expires_at: string;
  created_at: string;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Create a real `system.connection` item the mint endpoint can resolve.
 * Post-T-175 the mint endpoint requires the Connection to exist and be
 * `state: active`; pre-T-175 tests passed arbitrary connection_id strings.
 */
async function createActiveConnection(): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

describe("POST /system/runtime-credentials", () => {
  it("admin (which is a platform credential at bootstrap) can mint a runtime credential", async () => {
    const connectionId = await createActiveConnection();
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        label: `runtime ${suffix}`,
        source: `runtime-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RuntimeCredentialResponse;
    expect(body.api_key).toMatch(/^myme_k1_/);
    expect(body.connection_id).toBe(connectionId);
    expect(body.id).toBeDefined();
    expect(body.expires_at).toBeDefined();
  });

  it("T-175: refuses to mint for a non-existent connection_id", async () => {
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: "019e0000-0000-7000-0000-000000000000",
        label: "should-not-mint",
        source: "should-not-mint",
      },
    });
    expect(res.status).toBe(404);
  });

  it("T-175: refuses to mint for a revoked connection", async () => {
    const connectionId = await createActiveConnection();
    // Transition the connection to revoked — system.connection lifecycle
    // is active|revoked only; the standard transition path is the
    // uninstall pipeline (steps 1-5) culminating in `items.transition`.
    await ctx.storage.items.transition(connectionId, "revoked", undefined);

    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        label: "revoked-should-not-mint",
        source: "revoked-should-not-mint",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/revoked/i);
  });

  it("rejects callers without is_platform: true", async () => {
    // Mint a non-platform admin key first. The connection_id is irrelevant —
    // the is_platform gate runs before any connection lookup.
    const suffix = Math.random().toString(36).slice(2, 10);
    const memberRaw = `myme_k1_runtime_member_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `member-${suffix}`,
        source: `member-source-${suffix}`,
        role: "admin",
        type_permissions: { "*": "write" },
        is_platform: false,
      },
      hashApiKey(memberRaw, "test-salt"),
    );
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: memberRaw,
      body: {
        connection_id: "019e0000-0000-7000-0000-000000000001",
        label: "should fail",
        source: `should-fail-${suffix}`,
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/platform/i);
  });

  it("rejects unauthenticated callers", async () => {
    // Auth gate runs before any connection lookup; connection_id irrelevant.
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      body: {
        connection_id: "019e0000-0000-7000-0000-000000000002",
        label: "x",
        source: `x-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    expect(res.status).toBe(401);
  });

  it("validates the request body", async () => {
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        // missing connection_id
        label: "x",
        source: "x",
      },
    });
    expect(res.status).toBe(400);
  });

  it("stamps is_runtime_credential + connection_id on the row", async () => {
    const connectionId = await createActiveConnection();
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        label: `stamp ${suffix}`,
        source: `stamp-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RuntimeCredentialResponse;
    const stored = await ctx.storage.keys.get(body.id);
    expect(stored).not.toBeNull();
    expect(stored?.is_runtime_credential).toBe(true);
    expect(stored?.connection_id).toBe(connectionId);
    expect(stored?.is_platform).toBe(false);
    expect(stored?.role).toBe("member");
  });
});

describe("connection.runtime extension gate", () => {
  let runtimeKey: string;
  let connectionId: string;
  let runtimeKeyId: string;

  beforeAll(async () => {
    // Create a real system.connection — T-175 added an item-level
    // active-state gate to the mint endpoint, so this can no longer be
    // a placeholder core.note. (Pre-T-175 the gate keyed only off the
    // credential's connection_id stamp matching the URL :id.)
    connectionId = await createActiveConnection();

    const suffix = Math.random().toString(36).slice(2, 10);
    const mintRes = await request(
      ctx.app,
      "POST",
      "/system/runtime-credentials",
      {
        key: ctx.adminKey,
        body: {
          connection_id: connectionId,
          label: `gate ${suffix}`,
          source: `gate-${suffix}`,
        },
      },
    );
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as RuntimeCredentialResponse;
    runtimeKey = minted.api_key;
    runtimeKeyId = minted.id;
  });

  it("runtime credential CAN write its own connection's connection.runtime namespace", async () => {
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${connectionId}/extensions/connection.runtime`,
      {
        key: runtimeKey,
        body: { cursor: { last_run_at: "2026-05-01T00:00:00Z" } },
      },
    );
    expect(res.status).toBe(200);
  });

  it("runtime credential CANNOT write a different connection's connection.runtime namespace", async () => {
    // Create another item to act as a different connection.
    const otherItemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "other connection" } },
    });
    const otherBody = (await otherItemRes.json()) as { item: { id: string } };
    const otherId = otherBody.item.id;

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${otherId}/extensions/connection.runtime`,
      {
        key: runtimeKey,
        body: { cursor: "x" },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/connection_id|cannot write|cross/i);
  });

  it("admin credential CANNOT write the connection.runtime namespace (read-only for ops)", async () => {
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${connectionId}/extensions/connection.runtime`,
      {
        key: ctx.adminKey,
        body: { cursor: "should fail" },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/runtime credential/i);
  });

  it("ordinary credential without is_runtime_credential CANNOT write the namespace", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const ordinaryRaw = `myme_k1_ordinary_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `ordinary-${suffix}`,
        source: `ord-${suffix}`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: { "connection.runtime": "write" },
      },
      hashApiKey(ordinaryRaw, "test-salt"),
    );
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${connectionId}/extensions/connection.runtime`,
      {
        key: ordinaryRaw,
        body: { cursor: "x" },
      },
    );
    expect(res.status).toBe(403);
  });

  it("admin can READ the connection.runtime namespace (operator inspection)", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items/${connectionId}/extensions/connection.runtime`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      namespace: string;
      data: Record<string, unknown> | null;
    };
    expect(body.namespace).toBe("connection.runtime");
    expect(body.data).toMatchObject({
      cursor: { last_run_at: "2026-05-01T00:00:00Z" },
    });
  });

  it("runtime credential CAN delete its own connection.runtime namespace", async () => {
    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${connectionId}/extensions/connection.runtime`,
      { key: runtimeKey },
    );
    expect(res.status).toBe(200);
  });

  it("runtime credential CANNOT delete a different connection's namespace", async () => {
    const otherItemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "delete cross-tenant" } },
    });
    const otherBody = (await otherItemRes.json()) as { item: { id: string } };
    const otherId = otherBody.item.id;

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${otherId}/extensions/connection.runtime`,
      { key: runtimeKey },
    );
    expect(res.status).toBe(403);
  });

  // Sanity: the runtime credential row is queryable.
  it("the runtime credential is gettable via storage.keys.get", async () => {
    const stored = await ctx.storage.keys.get(runtimeKeyId);
    expect(stored?.is_runtime_credential).toBe(true);
    expect(stored?.connection_id).toBe(connectionId);
  });
});

// ---------------------------------------------------------------------------
// GET /system/connections/:id/verify-context (T-082) — control-plane lookup
// for the runtime-control verify route. Platform-credential gated; resolves
// integration_name + tenant_id from the connection's integration_ref.
// ---------------------------------------------------------------------------

describe("GET /system/connections/:id/verify-context", () => {
  async function buildActiveIntegrationConnection(
    integrationName: string,
  ): Promise<string> {
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: integrationName,
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "both",
          runtime_compatibility: ["hosted"],
          manifest: {
            name: integrationName,
            version: "1.0.0",
            publisher: "Acme",
          },
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
          granted_at: new Date().toISOString(),
          integration_ref: integration.id,
          configuration: {},
          runtime_status: "healthy",
        },
      },
      undefined,
    );
    return conn.id;
  }

  it("returns the integration_name + tenant_id for an active integration connection", async () => {
    const integrationName = `acme.verify-ctx-${Math.random().toString(36).slice(2, 10)}`;
    const id = await buildActiveIntegrationConnection(integrationName);
    const res = await request(
      ctx.app,
      "GET",
      `/system/connections/${id}/verify-context`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection_id: string;
      integration_name: string;
      tenant_id: string | null;
    };
    expect(body.connection_id).toBe(id);
    expect(body.integration_name).toBe(integrationName);
  });

  it("rejects callers without is_platform: true", async () => {
    const integrationName = `acme.verify-ctx-${Math.random().toString(36).slice(2, 10)}`;
    const id = await buildActiveIntegrationConnection(integrationName);

    const suffix = Math.random().toString(36).slice(2, 10);
    const memberRaw = `myme_k1_verify_member_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `verify-member-${suffix}`,
        source: `verify-member-${suffix}`,
        role: "admin",
        type_permissions: { "*": "write" },
        is_platform: false,
      },
      hashApiKey(memberRaw, "test-salt"),
    );
    const res = await request(
      ctx.app,
      "GET",
      `/system/connections/${id}/verify-context`,
      { key: memberRaw },
    );
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/system/connections/conn_nope/verify-context",
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the connection does not exist", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/system/connections/00000000-0000-7000-8000-000000000000/verify-context",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when the item is not kind=integration", async () => {
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme.app",
          manifest_version: "1.0.0",
          publisher: "Acme",
          manifest: { name: "acme.app", version: "1.0.0", publisher: "Acme" },
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const conn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: integration.id,
        },
      },
      undefined,
    );
    const res = await request(
      ctx.app,
      "GET",
      `/system/connections/${conn.id}/verify-context`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/integration/i);
  });

  it("returns 400 when the connection is not active", async () => {
    const integrationName = `acme.verify-ctx-paused-${Math.random().toString(36).slice(2, 10)}`;
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: integrationName,
          manifest_version: "1.0.0",
          publisher: "Acme",
          manifest: {
            name: integrationName,
            version: "1.0.0",
            publisher: "Acme",
          },
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
          status: "revoked",
          granted_at: new Date().toISOString(),
          integration_ref: integration.id,
        },
      },
      undefined,
    );
    const res = await request(
      ctx.app,
      "GET",
      `/system/connections/${conn.id}/verify-context`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/not active/i);
  });
});

// ---------------------------------------------------------------------------
// GET /system/connections/:id/dlq-context (T-084) — control-plane lookup
// for the runtime-control DLQ peek/replay routes. Platform-credential gated.
// Sibling of verify-context but does NOT narrow by kind or state — DLQs are
// often inspected precisely because the connection is unhealthy.
// ---------------------------------------------------------------------------

describe("GET /system/connections/:id/dlq-context", () => {
  it("returns the connection metadata for an active integration connection", async () => {
    const integrationName = `acme.dlq-ctx-${Math.random().toString(36).slice(2, 10)}`;
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: integrationName,
          manifest_version: "1.0.0",
          publisher: "Acme",
          manifest: {
            name: integrationName,
            version: "1.0.0",
            publisher: "Acme",
          },
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
          granted_at: new Date().toISOString(),
          integration_ref: integration.id,
        },
      },
      undefined,
    );
    const res = await request(
      ctx.app,
      "GET",
      `/system/connections/${conn.id}/dlq-context`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection_id: string;
      kind: string;
      state: string;
      integration_name: string | null;
      tenant_id: string | null;
    };
    expect(body.connection_id).toBe(conn.id);
    expect(body.kind).toBe("integration");
    expect(body.state).toBe("active");
    expect(body.integration_name).toBe(integrationName);
  });

  it("returns metadata for a revoked connection (DLQ inspection of unhealthy connections is the point)", async () => {
    const integrationName = `acme.dlq-ctx-revoked-${Math.random().toString(36).slice(2, 10)}`;
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: integrationName,
          manifest_version: "1.0.0",
          publisher: "Acme",
          manifest: {
            name: integrationName,
            version: "1.0.0",
            publisher: "Acme",
          },
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
          status: "revoked",
          granted_at: new Date().toISOString(),
          integration_ref: integration.id,
        },
      },
      undefined,
    );
    const res = await request(
      ctx.app,
      "GET",
      `/system/connections/${conn.id}/dlq-context`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      integration_name: string | null;
    };
    expect(body.kind).toBe("integration");
    expect(body.integration_name).toBe(integrationName);
  });

  it("rejects callers without is_platform: true", async () => {
    const conn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const suffix = Math.random().toString(36).slice(2, 10);
    const memberRaw = `myme_k1_dlq_member_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `dlq-member-${suffix}`,
        source: `dlq-member-${suffix}`,
        role: "admin",
        type_permissions: { "*": "write" },
        is_platform: false,
      },
      hashApiKey(memberRaw, "test-salt"),
    );
    const res = await request(
      ctx.app,
      "GET",
      `/system/connections/${conn.id}/dlq-context`,
      { key: memberRaw },
    );
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/system/connections/conn_nope/dlq-context",
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the connection does not exist", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/system/connections/00000000-0000-7000-8000-000000000000/dlq-context",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });

  it("returns null integration_name when integration_ref is missing", async () => {
    const conn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "tenant",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const res = await request(
      ctx.app,
      "GET",
      `/system/connections/${conn.id}/dlq-context`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      integration_name: string | null;
    };
    expect(body.kind).toBe("tenant");
    expect(body.integration_name).toBeNull();
  });
});
