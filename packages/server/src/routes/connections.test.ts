/**
 * Tests for the three connection-management routes that live alongside
 * each other in `routes/connections.ts`:
 *   - `POST /connections/install` (JSON install)
 *   - `POST /connections/:id/uninstall`
 *   - `POST /connections/preview-event` (bridge-envelope preview)
 *
 * Pipeline-level mechanics live in
 * `connections/install-pipeline.test.ts` and
 * `connections/uninstall-pipeline.test.ts`; reactive-run-bridge fanout
 * tests cover the queue-producer side. This file pins the route-layer
 * behaviour: auth gating, request-shape validation, error mapping, and
 * the JSON response shapes the SDK consumes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { performInstall } from "../connections/install-pipeline.js";
import { hashApiKey } from "../middleware/auth.js";
import type { IntegrationManifest } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "uninstall route test",
    direction: "both",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
  };
}

async function installFresh(): Promise<{
  connectionId: string;
  credentialId: string;
}> {
  const adminKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.role === "admin"));
  if (!adminKey) throw new Error("admin key not found in test ctx");

  const integrationName = `acme.uninstall-route-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: integrationName,
        manifest_version: "1.0.0",
        publisher: "Acme",
        direction: "both",
        runtime_compatibility: ["hosted"],
        manifest: manifest(integrationName) as unknown as Record<
          string,
          unknown
        >,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );

  const result = await performInstall(ctx.storage, "test-salt", {
    apiKeyId: adminKey.id,
    tenantId: undefined,
    integrationItemId: integration.id,
    manifest: manifest(integrationName),
    label: integrationName,
  });

  return {
    connectionId: result.connection_id,
    credentialId: result.credential_id,
  };
}

interface InstallResponse {
  connection_id: string;
  credential_id: string;
  activity_id: string;
}

interface UninstallResponse {
  connection_id: string;
  revoked_credential_ids: string[];
  oauth_tokens_deleted: boolean;
  leased_tokens_revoked: number;
  inbound_webhooks_disabled: number;
  activity_id: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

async function createIntegration(): Promise<{
  id: string;
  manifestName: string;
}> {
  const integrationName = `acme.install-route-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: integrationName,
        manifest_version: "1.0.0",
        publisher: "Acme",
        direction: "both",
        runtime_compatibility: ["hosted"],
        manifest: manifest(integrationName) as unknown as Record<
          string,
          unknown
        >,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return { id: integration.id, manifestName: integrationName };
}

describe("POST /connections/install — auth", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const integration = await createIntegration();
    const res = await request(ctx.app, "POST", "/connections/install", {
      body: { integration_id: integration.id },
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-admin (member) callers with 403", async () => {
    const integration = await createIntegration();
    const memberKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "install-member",
        source: `install-member-${Date.now().toString()}`,
        role: "member",
      },
    });
    const memberKey = ((await memberKeyRes.json()) as { key: string }).key;

    const res = await request(ctx.app, "POST", "/connections/install", {
      key: memberKey,
      body: { integration_id: integration.id },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /connections/install — happy path", () => {
  it("returns 201 with the install-result shape; the connection is reachable as system.connection", async () => {
    const integration = await createIntegration();

    const res = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.adminKey,
      body: { integration_id: integration.id },
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as InstallResponse;
    expect(body.connection_id).toMatch(/^[0-9a-f-]+$/);
    expect(body.credential_id).toMatch(/^[0-9a-f-]+$/);
    expect(body.activity_id).toMatch(/^[0-9a-f-]+$/);

    const conn = await ctx.storage.items.get(body.connection_id, undefined);
    expect(conn?.type).toBe("system.connection");
    const props = conn?.properties as { kind: string; integration_ref: string };
    expect(props.kind).toBe("integration");
    expect(props.integration_ref).toBe(integration.id);
  });

  it("threads body.configuration onto the new connection's properties.configuration", async () => {
    const integration = await createIntegration();
    const res = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.adminKey,
      body: {
        integration_id: integration.id,
        configuration: {
          upstream_base_url_override: "https://people.googleapis.com",
          custom_knob: 42,
        },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InstallResponse;
    const conn = await ctx.storage.items.get(body.connection_id, undefined);
    const config = (
      conn?.properties as { configuration?: Record<string, unknown> }
    ).configuration;
    expect(config).toMatchObject({
      upstream_base_url_override: "https://people.googleapis.com",
      custom_knob: 42,
    });
  });

  it("uses the explicit label on the seed credential when provided, falling back to manifest name + version otherwise", async () => {
    const integration = await createIntegration();

    const labeled = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.adminKey,
      body: { integration_id: integration.id, label: "Custom label" },
    });
    expect(labeled.status).toBe(201);
    const labeledBody = (await labeled.json()) as InstallResponse;
    const labeledCred = (await ctx.storage.keys.list()).find(
      (k) => k.id === labeledBody.credential_id,
    );
    expect(labeledCred?.label).toBe("Custom label");

    const integration2 = await createIntegration();
    const defaulted = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.adminKey,
      body: { integration_id: integration2.id },
    });
    expect(defaulted.status).toBe(201);
    const defaultedBody = (await defaulted.json()) as InstallResponse;
    const defaultedCred = (await ctx.storage.keys.list()).find(
      (k) => k.id === defaultedBody.credential_id,
    );
    expect(defaultedCred?.label).toBe(`${integration2.manifestName} 1.0.0`);
  });
});

describe("POST /connections/install — error mapping", () => {
  it("returns 404 for an unknown integration_id", async () => {
    const res = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.adminKey,
      body: { integration_id: "00000000-0000-7000-8000-000000000000" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("integration_not_found");
  });

  it("returns 400 when integration_id refers to a non-system.integration item", async () => {
    const note = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "decoy — not an integration" },
      },
      undefined,
    );
    const res = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.adminKey,
      body: { integration_id: note.id },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody & {
      error: { details?: { actual_type?: string } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.actual_type).toBe("core.note");
  });
});

describe("POST /connections/install — platform-scoped manifest, tenant_admin caller", () => {
  // Without `includePlatformScoped`, manifests registered by a platform credential are invisible to
  // tenant_admin callers (tenant_id IS NULL rows don't match). Pin success + tenant-stamping invariant.
  it("tenant_admin can install a platform-scoped manifest; resulting connection lands in caller tenant", async () => {
    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("t234-conn-install");
    const integration = await createIntegration(); // tenant_id: null

    const suffix = Math.random().toString(36).slice(2, 8);
    const rawKey = `marfa_k1_test_tadmin_${suffix}`;
    const hash = hashApiKey(rawKey, TEST_API_KEY_SALT);
    await ctx.storage.keys.create(
      {
        label: `t234-tadmin-${suffix}`,
        source: `t234-tadmin-${suffix}`,
        role: "tenant_admin",
        default_tier: "library",
        is_platform: false,
      },
      hash,
      tenant.id,
    );

    const res = await request(ctx.app, "POST", "/connections/install", {
      key: rawKey,
      body: { integration_id: integration.id },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InstallResponse;

    const conn = await ctx.storage.items.get(body.connection_id, tenant.id);
    expect(conn?.type).toBe("system.connection");
    expect(conn?.tenant_id).toBe(tenant.id);
    const props = conn?.properties as { integration_ref?: string };
    expect(props.integration_ref).toBe(integration.id);
  });
});

describe("POST /connections/:id/uninstall — auth", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const installed = await installFresh();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-admin (member) callers with 403", async () => {
    const installed = await installFresh();
    const memberKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "uninstall-member",
        source: `uninstall-member-${Date.now().toString()}`,
        role: "member",
      },
    });
    const memberKey = ((await memberKeyRes.json()) as { key: string }).key;

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: memberKey },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /connections/:id/uninstall — happy path", () => {
  it("returns 200 with the cleanup-counts shape and revokes the credential", async () => {
    const installed = await installFresh();

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as UninstallResponse;

    expect(body.connection_id).toBe(installed.connectionId);
    expect(body.revoked_credential_ids).toEqual([installed.credentialId]);
    expect(body.oauth_tokens_deleted).toBe(false);
    expect(body.leased_tokens_revoked).toBe(0);
    expect(body.inbound_webhooks_disabled).toBe(0);
    expect(body.activity_id).toMatch(/^[0-9a-f-]+$/);

    const credAfter = (await ctx.storage.keys.list()).find(
      (k) => k.id === installed.credentialId,
    );
    expect(credAfter).toBeUndefined();

    const conn = await ctx.storage.items.getIncludingTrashed(
      installed.connectionId,
      undefined,
    );
    expect(conn?.state).toBe("revoked");
  });
});

describe("POST /connections/:id/uninstall — error mapping", () => {
  it("returns 404 for an unknown connection id", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/connections/00000000-0000-7000-8000-000000000000/uninstall",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("connection_not_found");
  });

  it("returns 400 with uninstall_error_code=already_revoked on second call", async () => {
    const installed = await installFresh();

    const first = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: ctx.adminKey },
    );
    expect(first.status).toBe(200);

    const second = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: ctx.adminKey },
    );
    expect(second.status).toBe(400);
    const body = (await second.json()) as ErrorBody & {
      error: { details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.uninstall_error_code).toBe("already_revoked");
  });

  it("returns 400 with uninstall_error_code=wrong_connection_kind for an app", async () => {
    const grant = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${grant.id}/uninstall`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody & {
      error: { details?: Record<string, unknown> };
    };
    expect(body.error.details?.uninstall_error_code).toBe(
      "wrong_connection_kind",
    );
  });
});

// ---------------------------------------------------------------------------
// `POST /connections/preview-event` — render bridge envelopes for a
// synthetic event without dispatch. Auth gate, the four `dispatch_reason`s
// the route surfaces, and the unfiltered walk's silence on non-subscribers.
// Cross-tenant gating is exercised by the bridge's own tests; the preview
// route's single-tenant tests don't recreate that fixture.
// ---------------------------------------------------------------------------

interface PreviewBody {
  envelopes: {
    connection_id: string;
    integration_name: string;
    would_dispatch: boolean;
    dispatch_reason:
      | "ok"
      | "self_event"
      | "cross_tenant"
      | "hop_budget_exceeded"
      | "subscription_inactive";
    envelope?: {
      kind: "item-event";
      integration_name: string;
      connection_id: string;
      event_type: string;
      item_id: string;
      cycle: {
        originating_connection_id: string | null;
        hop_count: number;
      };
      payload: unknown;
    };
  }[];
  hop_budget: { max: number; used: number };
}

function manifestWithItemEventTrigger(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "preview-event route test",
    direction: "both",
    triggers: [{ type: "item-event" }], // buildEntryForConnection returns null without this trigger
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
  };
}

async function installItemEventConnection(): Promise<{
  connectionId: string;
}> {
  const adminKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.role === "admin"));
  if (!adminKey) throw new Error("admin key not found in test ctx");

  const integrationName = `acme.preview-event-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: integrationName,
        manifest_version: "1.0.0",
        publisher: "Acme",
        direction: "both",
        runtime_compatibility: ["hosted"],
        manifest: manifestWithItemEventTrigger(
          integrationName,
        ) as unknown as Record<string, unknown>,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const result = await performInstall(ctx.storage, "test-salt", {
    apiKeyId: adminKey.id,
    tenantId: undefined,
    integrationItemId: integration.id,
    manifest: manifestWithItemEventTrigger(integrationName),
    label: integrationName,
  });
  return { connectionId: result.connection_id };
}

describe("POST /connections/preview-event — auth", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      body: {
        item_id: "00000000-0000-7000-8000-000000000000",
        event_type: "created",
      },
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-admin (member) callers with 403", async () => {
    const memberKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "preview-member",
        source: `preview-member-${Date.now().toString()}`,
        role: "member",
      },
    });
    const memberKey = ((await memberKeyRes.json()) as { key: string }).key;

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: memberKey,
      body: {
        item_id: "00000000-0000-7000-8000-000000000000",
        event_type: "created",
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /connections/preview-event — error mapping", () => {
  it("returns 404 when item_id does not resolve", async () => {
    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.adminKey,
      body: {
        item_id: "00000000-0000-7000-8000-000000000000",
        event_type: "created",
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("item_not_found");
  });

  it("returns 404 when the filtered connection_id does not resolve", async () => {
    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      undefined,
    );
    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.adminKey,
      body: {
        item_id: note.id,
        event_type: "created",
        connection_id: "00000000-0000-7000-8000-000000000000",
      },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /connections/preview-event — happy path", () => {
  it("returns the bridge envelope for an active item-event subscriber (filtered to one connection)", async () => {
    const { connectionId } = await installItemEventConnection();
    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      undefined,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.adminKey,
      body: {
        item_id: note.id,
        event_type: "created",
        connection_id: connectionId,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    expect(body.envelopes).toHaveLength(1);
    const row = body.envelopes[0]!;
    expect(row.would_dispatch).toBe(true);
    expect(row.dispatch_reason).toBe("ok");
    expect(row.connection_id).toBe(connectionId);
    expect(row.envelope?.kind).toBe("item-event");
    expect(row.envelope?.event_type).toBe("item.created");
    expect(row.envelope?.item_id).toBe(note.id);
    expect(row.envelope?.cycle.hop_count).toBe(0);
    expect(row.envelope?.cycle.originating_connection_id).toBeNull();
    expect(body.hop_budget.max).toBe(5);
    expect(body.hop_budget.used).toBe(0);
  });

  it("walks all subscribers when connection_id is omitted, and silently skips non-subscribers", async () => {
    const { connectionId } = await installItemEventConnection();
    // A second `system.connection` of kind `app` (not an item-event
    // subscriber) — should not appear in the envelopes list because the
    // unfiltered case omits non-subscribers as noise.
    const appConn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );

    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      undefined,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.adminKey,
      body: { item_id: note.id, event_type: "created" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    const ids = body.envelopes.map((e) => e.connection_id);
    expect(ids).toContain(connectionId);
    expect(ids).not.toContain(appConn.id);
  });
});

describe("POST /connections/preview-event — non-dispatch reasons", () => {
  it("reports `subscription_inactive` when the filtered connection_id is not an item-event subscriber", async () => {
    // app-kind connections are not item-event subscribers; the route stamps subscription_inactive.
    const appConn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      undefined,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.adminKey,
      body: {
        item_id: note.id,
        event_type: "created",
        connection_id: appConn.id,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    expect(body.envelopes).toHaveLength(1);
    const row = body.envelopes[0]!;
    expect(row.would_dispatch).toBe(false);
    expect(row.dispatch_reason).toBe("subscription_inactive");
    expect(row.envelope).toBeUndefined();
  });

  it("reports `self_event` when the synthetic event originates from the subscribed connection itself", async () => {
    const { connectionId } = await installItemEventConnection();
    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      undefined,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.adminKey,
      body: {
        item_id: note.id,
        event_type: "created",
        connection_id: connectionId,
        cycle: { originating_connection_id: connectionId, hop_count: 1 },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    const row = body.envelopes[0]!;
    expect(row.would_dispatch).toBe(false);
    expect(row.dispatch_reason).toBe("self_event");
    expect(body.hop_budget.used).toBe(1);
  });

  it("reports `hop_budget_exceeded` when the synthetic event would have been dropped upstream of the bridge", async () => {
    const { connectionId } = await installItemEventConnection();
    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      undefined,
    );

    // Default hop budget is 5; hop_count: 99 with a non-null originating
    // id makes this connector-originated and over budget.
    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.adminKey,
      body: {
        item_id: note.id,
        event_type: "created",
        connection_id: connectionId,
        cycle: {
          originating_connection_id: "00000000-0000-7000-8000-000000000999",
          hop_count: 99,
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    const row = body.envelopes[0]!;
    expect(row.would_dispatch).toBe(false);
    expect(row.dispatch_reason).toBe("hop_budget_exceeded");
    expect(row.envelope).toBeUndefined();
    expect(body.hop_budget.used).toBe(99);
    expect(body.hop_budget.max).toBe(5);
  });
});
