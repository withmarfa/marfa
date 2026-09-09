/**
 * Tests for the three connection-management routes that live alongside
 * each other in `routes/connections.ts`:
 *   - `POST /connections/install` (JSON install)
 *   - `POST /connections/:id/uninstall`
 *   - `POST /connections/preview-event` (bridge-envelope preview)
 *
 * Pipeline-level mechanics live in
 * `connections/install-pipeline.test/ts` and
 * `connections/uninstall-pipeline.test/ts`; the local-runtime bridge
 * suite covers fanout. This file pins the route-layer
 * behavior: auth gating, request-shape validation, error mapping, and
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
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";
import { hashApiKey } from "../middleware/auth.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

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
    publisher: "acme",
    description: "uninstall route test",
    direction: "both",
    runs_on: "server" as const,
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
    configuration_schema: {
      custom_knob: {
        type: "number",
        description: "Fixture knob for the configuration-threading test.",
      },
    },
  };
}

async function installFresh(): Promise<{
  connectionId: string;
  credentialId: string;
}> {
  const operatorKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.is_operator));
  if (!operatorKey) throw new Error("operator key not found in test ctx");

  const integrationName = `acme/uninstall-route-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: integrationName,
        manifest_version: "1.0.0",
        publisher: "acme",
        direction: "both",
        manifest: manifest(integrationName),
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );

  const result = await performInstall(ctx.storage, {
    apiKeyId: operatorKey.id,
    spaceId: ctx.spaceId,
    integrationItemId: integration.id,
    manifest: manifest(integrationName),
  });

  return {
    connectionId: result.connection_id,
    // Installing mints nothing, so the credential the uninstall route
    // revokes is the one a dispatch would have left behind.
    credentialId: await mintRuntimeCredentialId(result.connection_id),
  };
}

/** Mint a runtime credential the way a dispatch does, and resolve the row
 *  id the mint does not return. */
async function mintRuntimeCredentialId(connectionId: string): Promise<string> {
  await mintLocalRuntimeCredential(
    ctx.storage,
    TEST_API_KEY_SALT,
    connectionId,
  );
  const bound = await ctx.storage.keys.listByConnectionId(
    connectionId,
    undefined,
  );
  const runtime = bound.find((k) => k.is_runtime_credential);
  if (!runtime) throw new Error("runtime credential did not resolve");
  return runtime.id;
}

interface InstallResponse {
  connection_id: string;
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
  const integrationName = `acme/install-route-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: integrationName,
        manifest_version: "1.0.0",
        publisher: "acme",
        direction: "both",
        manifest: manifest(integrationName),
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

  it("rejects a caller without space.connections with 403", async () => {
    const integration = await createIntegration();
    const unprivilegedKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "install-unprivileged",
        source: `install-unprivileged-${Date.now().toString()}`,
        space_permissions: [],
      },
    });
    const unprivilegedKey = (
      (await unprivilegedKeyRes.json()) as { key: string }
    ).key;

    const res = await request(ctx.app, "POST", "/connections/install", {
      key: unprivilegedKey,
      body: { integration_id: integration.id },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /connections/install — happy path", () => {
  it("returns 201 with the install-result shape; the connection is reachable as system.connection", async () => {
    const integration = await createIntegration();

    const res = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.spaceKey,
      body: { integration_id: integration.id },
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as InstallResponse;
    expect(body.connection_id).toMatch(/^[0-9a-f-]+$/);
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
      key: ctx.spaceKey,
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

  // A case here used to prove `label` did something by reading it back
  // off the seed credential it named. The credential went first, because
  // nothing could present it, and the field followed: a
  // `system.connection` declares no label, so there was nowhere to put
  // the value. Naming a Connection means giving the type a field first.
});

describe("POST /connections/install — error mapping", () => {
  it("returns 404 for an unknown integration_id", async () => {
    const res = await request(ctx.app, "POST", "/connections/install", {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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

describe("POST /connections/install — platform-scoped manifest, space-bound caller", () => {
  // Without `includePlatformScoped`, manifests registered by an operator credential are invisible
  // to a space-bound caller (space_id IS NULL rows don't match). Pin success + space-stamping invariant.
  it("a space-bound caller can install a platform-scoped manifest; the connection lands in its space", async () => {
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("t234-conn-install");
    const integration = await createIntegration(); // space_id: null

    const suffix = Math.random().toString(36).slice(2, 8);
    const rawKey = `marfa_k1_test_tadmin_${suffix}`;
    const hash = hashApiKey(rawKey, TEST_API_KEY_SALT);
    await ctx.storage.keys.create(
      {
        label: `t234-tadmin-${suffix}`,
        source: `t234-tadmin-${suffix}`,
        space_permissions: [...SPACE_PERMISSIONS],
        default_tier: "library",
        is_operator: false,
      },
      hash,
      space.id,
    );

    const res = await request(ctx.app, "POST", "/connections/install", {
      key: rawKey,
      body: { integration_id: integration.id },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InstallResponse;

    const conn = await ctx.storage.items.get(body.connection_id, space.id);
    expect(conn?.type).toBe("system.connection");
    expect(conn?.space_id).toBe(space.id);
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

  it("rejects a caller without space.connections with 403", async () => {
    const installed = await installFresh();
    const unprivilegedKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "uninstall-unprivileged",
        source: `uninstall-unprivileged-${Date.now().toString()}`,
        space_permissions: [],
      },
    });
    const unprivilegedKey = (
      (await unprivilegedKeyRes.json()) as { key: string }
    ).key;

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: unprivilegedKey },
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
    );
    expect(first.status).toBe(200);

    const second = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: ctx.spaceKey },
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
      // The claim is about `kind`, so the row goes in the caller's space:
      // uninstall resolves the connection fenced to it, and a space-less row
      // answers 404 before the kind is ever read.
      ctx.spaceId,
    );
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${grant.id}/uninstall`,
      { key: ctx.spaceKey },
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
// synthetic event without dispatch. Auth gate, the `dispatch_reason`s
// the route surfaces, and the unfiltered walk's silence on non-subscribers.
// Cross-space gating is exercised by the bridge's own tests; the preview
// route's single-space tests don't recreate that fixture.
// ---------------------------------------------------------------------------

interface PreviewBody {
  envelopes: {
    connection_id: string;
    integration_name: string;
    would_dispatch: boolean;
    dispatch_reason:
      | "ok"
      | "self_event"
      | "cross_space"
      | "system_type"
      | "type_not_targeted"
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
    publisher: "acme",
    description: "preview-event route test",
    direction: "both",
    runs_on: "server" as const,
    triggers: [{ type: "item-event" }], // buildEntryForConnection returns null without this trigger
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
  };
}

async function installItemEventConnection(): Promise<{
  connectionId: string;
}> {
  const operatorKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.is_operator));
  if (!operatorKey) throw new Error("operator key not found in test ctx");

  const integrationName = `acme/preview-event-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: integrationName,
        manifest_version: "1.0.0",
        publisher: "acme",
        direction: "both",
        manifest: manifestWithItemEventTrigger(integrationName),
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const result = await performInstall(ctx.storage, {
    apiKeyId: operatorKey.id,
    spaceId: ctx.spaceId,
    integrationItemId: integration.id,
    manifest: manifestWithItemEventTrigger(integrationName),
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

  it("rejects a caller without space.connections with 403", async () => {
    const unprivilegedKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "preview-unprivileged",
        source: `preview-unprivileged-${Date.now().toString()}`,
        space_permissions: [],
      },
    });
    const unprivilegedKey = (
      (await unprivilegedKeyRes.json()) as { key: string }
    ).key;

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: unprivilegedKey,
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
      key: ctx.spaceKey,
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
      ctx.spaceId,
    );
    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.spaceKey,
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
      ctx.spaceId,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.spaceKey,
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
      // In the caller's space, so the route can reach it. A row the space
      // walk cannot see would satisfy the assertions below without the
      // route having judged it at all.
      ctx.spaceId,
    );

    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      ctx.spaceId,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.spaceKey,
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
      // In the caller's space, so the route can reach it. A row the space
      // walk cannot see would satisfy the assertions below without the
      // route having judged it at all.
      ctx.spaceId,
    );
    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      ctx.spaceId,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.spaceKey,
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
      ctx.spaceId,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.spaceKey,
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

  it("reports `type_not_targeted` for an item type outside the manifest's target_types", async () => {
    const { connectionId } = await installItemEventConnection();
    // The manifest declares core.note only; a bookmark is a real,
    // non-system type the subscriber never claimed.
    const bookmark = await ctx.storage.items.create(
      {
        type: "core.bookmark",
        properties: { url: "https://example.com/preview" },
      },
      ctx.spaceId,
    );

    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.spaceKey,
      body: {
        item_id: bookmark.id,
        event_type: "created",
        connection_id: connectionId,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    const row = body.envelopes[0]!;
    expect(row.would_dispatch).toBe(false);
    expect(row.dispatch_reason).toBe("type_not_targeted");
    expect(row.envelope).toBeUndefined();
  });

  it("reports `hop_budget_exceeded` when the synthetic event would have been dropped upstream of the bridge", async () => {
    const { connectionId } = await installItemEventConnection();
    const note = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "preview target" } },
      ctx.spaceId,
    );

    // Default hop budget is 5; hop_count: 99 with a non-null originating
    // id makes this integration-originated and over budget.
    const res = await request(ctx.app, "POST", "/connections/preview-event", {
      key: ctx.spaceKey,
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
