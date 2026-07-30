import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import type { IntegrationManifest } from "@withmarfa/shared";

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

/** The integration every fixture connection below is installed for. A
 *  mint has to name it, and the server checks the name against the
 *  manifest persisted on the connection. */
const MANIFEST_NAME = "acme.runtime-permissions";
/** A different in-tree-shaped name, for the sibling-Worker cases. */
const OTHER_MANIFEST_NAME = "acme.other-integration";

/**
 * Create a real `system.connection` item the mint endpoint can resolve,
 * with its Integration manifest persisted. The mint endpoint requires the
 * Connection to exist, be `state: active`, and belong to the integration
 * the caller names.
 */
async function createActiveConnection(spaceId?: string): Promise<string> {
  return createManifestConnection(spaceId);
}

/** A Connection with no `integration_ref` at all — nothing the mint can
 *  check a caller against. */
async function createUnresolvableConnection(spaceId?: string): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
      },
    },
    spaceId,
  );
  return item.id;
}

function runtimeManifest(name = MANIFEST_NAME): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "Exercises hosted runtime permission projection",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
    permissions: {
      extension: {
        "acme.cursor": "write",
        // The substrate grant wins over a manifest downgrade.
        "connection.runtime": "read",
      },
      edge: { about: "read" },
    },
  };
}

async function createManifestConnection(
  spaceId?: string,
  name = MANIFEST_NAME,
): Promise<string> {
  const manifest = runtimeManifest(name);
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        publisher: manifest.publisher,
        manifest,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integration.id,
      },
    },
    spaceId,
  );
  return connection.id;
}

async function expireCredential(id: string): Promise<void> {
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  if ((process.env.DB_DIALECT ?? "sqlite") === "pg") {
    const storage = ctx.storage as unknown as {
      __pgClient: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await storage.__pgClient(
      "UPDATE api_keys SET expires_at = $1 WHERE id = $2",
      [expiredAt, id],
    );
  } else {
    const storage = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await storage.__sqliteRun(
      "UPDATE api_keys SET expires_at = ? WHERE id = ?",
      [expiredAt, id],
    );
  }
}

describe("POST /system/runtime-credentials", () => {
  it("admin (which is a platform credential at bootstrap) can mint a runtime credential", async () => {
    const connectionId = await createActiveConnection();
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        integration_name: MANIFEST_NAME,
        label: `runtime ${suffix}`,
        source: `runtime-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RuntimeCredentialResponse;
    expect(body.api_key).toMatch(/^marfa_k1_/);
    expect(body.connection_id).toBe(connectionId);
    expect(body.id).toBeDefined();
    expect(body.expires_at).toBeDefined();
  });

  it("refuses to mint for a non-existent connection_id", async () => {
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: "019e0000-0000-7000-0000-000000000000",
        integration_name: MANIFEST_NAME,
        label: "should-not-mint",
        source: "should-not-mint",
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    // Connection-specific, not the generic `not_found` a misrouted
    // request would produce — the broker reads this code as "tear the
    // schedule down", so a routing miss must not be able to forge it.
    expect(body.error.code).toBe("connection_not_found");
  });

  it("refuses to mint for a revoked connection", async () => {
    const connectionId = await createActiveConnection();
    // Transition the connection to revoked — system.connection lifecycle
    // is active|revoked only; the standard transition path is the
    // uninstall pipeline (steps 1-5) culminating in `items.transition`.
    await ctx.storage.items.transition(connectionId, "revoked", undefined);

    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        integration_name: MANIFEST_NAME,
        label: "revoked-should-not-mint",
        source: "revoked-should-not-mint",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/revoked/i);
    expect(body.error.code).toBe("connection_not_active");
  });

  /**
   * The two 403s this route can return mean opposite things to the lease
   * broker: a revoked connection is a terminal per-connection verdict
   * that tears its schedule down for good, while a non-platform caller is
   * a global authorization failure that says nothing about any
   * connection. `MARFA_RUNTIME_BROKER_KEY` rotated to a valid but
   * space-scoped admin key produces the second for every connection in
   * every space, so if the two share a code the whole scheduled fleet
   * deschedules itself within one cron period, recoverable only one
   * connection at a time.
   */
  it("separates the connection-state 403 from the platform-credential 403 by code", async () => {
    const connectionId = await createActiveConnection();
    await ctx.storage.items.transition(connectionId, "revoked", undefined);
    const revoked = await request(
      ctx.app,
      "POST",
      "/system/runtime-credentials",
      {
        key: ctx.adminKey,
        body: {
          connection_id: connectionId,
          integration_name: MANIFEST_NAME,
          label: "revoked",
          source: `revoked-${connectionId}`,
        },
      },
    );

    const suffix = Math.random().toString(36).slice(2, 10);
    const spaceScopedRaw = `marfa_k1_space_admin_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `space-admin-${suffix}`,
        source: `space-admin-source-${suffix}`,
        role: "admin",
        type_permissions: { "*": "write" },
        is_platform: false,
      },
      hashApiKey(spaceScopedRaw, "test-salt"),
    );
    const nonPlatform = await request(
      ctx.app,
      "POST",
      "/system/runtime-credentials",
      {
        key: spaceScopedRaw,
        body: {
          connection_id: connectionId,
          integration_name: MANIFEST_NAME,
          label: "non-platform",
          source: `non-platform-${suffix}`,
        },
      },
    );

    expect(revoked.status).toBe(403);
    expect(nonPlatform.status).toBe(403);
    const revokedBody = (await revoked.json()) as ErrorResponse;
    const nonPlatformBody = (await nonPlatform.json()) as ErrorResponse;
    expect(revokedBody.error.code).toBe("connection_not_active");
    expect(nonPlatformBody.error.code).toBe("forbidden");
    expect(nonPlatformBody.error.code).not.toBe(revokedBody.error.code);
  });

  it("rejects callers without is_platform: true", async () => {
    // Mint a non-platform admin key first. The connection_id is irrelevant —
    // the is_platform gate runs before any connection lookup.
    const suffix = Math.random().toString(36).slice(2, 10);
    const memberRaw = `marfa_k1_runtime_member_${suffix}`;
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
        integration_name: MANIFEST_NAME,
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
        integration_name: MANIFEST_NAME,
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
        integration_name: MANIFEST_NAME,
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

  it("binds the credential to the connection's space, not the broker's", async () => {
    // The broker authenticates with a platform credential that carries no
    // space. Stamping the caller's space would leave the credential
    // space-less, which reads as "platform tier" to the RLS policies and
    // to the storage layer's space predicate — an integration for one
    // space would reach every space.
    const suffix = Math.random().toString(36).slice(2, 10);
    const spaceId = `space-rc-${suffix}`;
    const connectionId = await createActiveConnection(spaceId);

    // `ctx.adminKey` is a platform credential with no space, matching the
    // broker key the hosted control plane presents.
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        integration_name: MANIFEST_NAME,
        label: `space-bound ${suffix}`,
        source: `space-bound-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RuntimeCredentialResponse;

    const stored = await ctx.storage.keys.get(body.id);
    expect(stored?.space_id).toBe(spaceId);
  });

  it("projects permissions from the persisted manifest and ignores injected maps", async () => {
    const spaceId = `space-rc-${Math.random().toString(36).slice(2, 10)}`;
    const connectionId = await createManifestConnection(spaceId);
    const suffix = Math.random().toString(36).slice(2, 10);

    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        integration_name: MANIFEST_NAME,
        label: `projected ${suffix}`,
        source: `projected-${suffix}`,
        // Legacy control planes sent these fields. Unknown-field stripping
        // keeps a staged rollout compatible, while server-owned projection
        // makes escalation impossible.
        type_permissions: { "*": "write" },
        extension_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RuntimeCredentialResponse;
    const stored = await ctx.storage.keys.get(body.id);
    expect(stored?.type_permissions).toEqual({
      "system.activity": "write",
      "core.note": "write",
    });
    expect(stored?.extension_permissions).toEqual({
      "connection.runtime": "write",
      "acme.cursor": "write",
    });
    expect(stored?.edge_permissions).toEqual({ about: "read" });
    expect(stored?.type_permissions["*"]).toBeUndefined();
  });

  it("refuses a connection with no resolvable manifest", async () => {
    // Nothing here can show the connection belongs to the caller, and a
    // check whose job is proving ownership has to read "cannot prove" as
    // "no". The local substrate's mint keeps the fail-closed projection
    // instead — see `local-runtime/credentials.test.ts` — because it has
    // no caller to bind to in the first place.
    const connectionId = await createUnresolvableConnection();
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        integration_name: MANIFEST_NAME,
        label: `closed ${suffix}`,
        source: `closed-${suffix}`,
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponse).error.code).toBe(
      "validation_error",
    );
  });

  /**
   * The property the per-Worker identity model rests on at this end.
   *
   * The control plane authenticates a Worker against a key derived from
   * its integration name and forwards the name it proved. This route is
   * where that claim meets state neither the Worker nor the control
   * plane can edit: the manifest persisted on the Connection at install
   * time. Without it, a Worker that learns a sibling's Connection id —
   * from a misrouted queue envelope, an operator surface, a log — leases
   * a credential scoped to another integration's data.
   */
  it("refuses a Connection installed for a different integration", async () => {
    const spaceId = `space-rc-${Math.random().toString(36).slice(2, 10)}`;
    const connectionId = await createManifestConnection(spaceId);
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        integration_name: OTHER_MANIFEST_NAME,
        label: `sibling ${suffix}`,
        source: `sibling-${suffix}`,
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("forbidden");
    // The refusal does not name the integration the Connection belongs
    // to. A caller that does not own it has no business learning that.
    expect(body.error.message).not.toContain(MANIFEST_NAME);
  });

  it("requires the caller to name an integration at all", async () => {
    // Optional would mean a caller opts out of the binding by omission,
    // which is the same as not having it.
    const connectionId = await createManifestConnection();
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connectionId,
        label: "unnamed",
        source: `unnamed-${Math.random().toString(36).slice(2, 10)}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a system.connection whose kind is not integration", async () => {
    const connection = await ctx.storage.items.create(
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
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: connection.id,
        integration_name: MANIFEST_NAME,
        label: "not an integration",
        source: `not-integration-${Math.random().toString(36).slice(2, 10)}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("revokes an expired sibling after a successful hosted mint", async () => {
    const connectionId = await createManifestConnection();
    const firstSuffix = Math.random().toString(36).slice(2, 10);
    const firstRes = await request(
      ctx.app,
      "POST",
      "/system/runtime-credentials",
      {
        key: ctx.adminKey,
        body: {
          connection_id: connectionId,
          integration_name: MANIFEST_NAME,
          label: `first ${firstSuffix}`,
          source: `first-${firstSuffix}`,
        },
      },
    );
    expect(firstRes.status).toBe(201);
    const first = (await firstRes.json()) as RuntimeCredentialResponse;
    await expireCredential(first.id);

    const secondSuffix = Math.random().toString(36).slice(2, 10);
    const secondRes = await request(
      ctx.app,
      "POST",
      "/system/runtime-credentials",
      {
        key: ctx.adminKey,
        body: {
          connection_id: connectionId,
          integration_name: MANIFEST_NAME,
          label: `second ${secondSuffix}`,
          source: `second-${secondSuffix}`,
        },
      },
    );
    expect(secondRes.status).toBe(201);
    expect(await ctx.storage.keys.get(first.id)).toBeNull();
  });
});

describe("connection.runtime extension gate", () => {
  let runtimeKey: string;
  let connectionId: string;
  let runtimeKeyId: string;

  beforeAll(async () => {
    // Create a real system.connection — the mint endpoint requires an
    // active-state item of type system.connection, not a placeholder.
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
          integration_name: MANIFEST_NAME,
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
    const ordinaryRaw = `marfa_k1_ordinary_${suffix}`;
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
      body: { type: "core.note", properties: { body: "delete cross-space" } },
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
// GET /system/connections/:id/verify-context — control-plane lookup for
// the runtime-control verify route. Platform-credential gated; resolves
// integration_name + space_id from the connection's integration_ref.
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

  it("returns the integration_name + space_id for an active integration connection", async () => {
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
      space_id: string | null;
    };
    expect(body.connection_id).toBe(id);
    expect(body.integration_name).toBe(integrationName);
  });

  it("rejects callers without is_platform: true", async () => {
    const integrationName = `acme.verify-ctx-${Math.random().toString(36).slice(2, 10)}`;
    const id = await buildActiveIntegrationConnection(integrationName);

    const suffix = Math.random().toString(36).slice(2, 10);
    const memberRaw = `marfa_k1_verify_member_${suffix}`;
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
// GET /system/connections/:id/dlq-context — control-plane lookup for
// the runtime-control DLQ peek/replay routes. Platform-credential gated.
// Sibling of verify-context but does NOT narrow by kind or state — DLQs
// are often inspected precisely because the connection is unhealthy.
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
      space_id: string | null;
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
    const memberRaw = `marfa_k1_dlq_member_${suffix}`;
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
    // `kind: app` connections (OAuth grants) don't carry `integration_ref`,
    // so they exercise the same null-integration_name codepath without
    // needing a synthetic `kind`.
    const conn = await ctx.storage.items.create(
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
      "GET",
      `/system/connections/${conn.id}/dlq-context`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      integration_name: string | null;
    };
    expect(body.kind).toBe("app");
    expect(body.integration_name).toBeNull();
  });
});
