import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type {
  CreatedConnectionLeasedToken,
  ConnectionLeasedToken,
  LeaseTokenIntrospection,
} from "@withmarfa/shared";
import { hashApiKey } from "../middleware/auth.js";
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";

let ctx: TestContext;
/** Registered system.integration id pointing at VALID_MANIFEST. */
let integrationId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const reg = await request(ctx.app, "POST", "/integrations", {
    key: ctx.operatorKey,
    body: { manifest: VALID_MANIFEST },
  });
  if (reg.status !== 201) {
    throw new Error(
      `lease-tokens test setup: integration register failed (${String(reg.status)})`,
    );
  }
  const regBody = (await reg.json()) as { id: string };
  integrationId = regBody.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

const VALID_MANIFEST = {
  name: "acme/integration",
  version: "1.0.0",
  publisher: "acme",
  description: "Demo integration",
  direction: "both" as const,
  triggers: [{ type: "webhook" as const }],
  target_types: ["core.note"],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "prompt-user" as const,
    partial_write_mode: "all-or-nothing" as const,
  },
  oauth_requirements: {
    "drive.upload": "leased" as const,
    "drive.read": "proxy" as const,
  },
  webhook_verification: { method: "hmac-sha256" as const },
  manifest_schema_version: "2.0.0",
};

// Written through storage rather than `POST /items`, because neither
// credential can do this over the wire: the reserved namespace admits only a
// operator key, and that one holds no space to put the row in. A
// connection is the install pipeline's to create, and it names the space.
async function createConnection(
  integrationRef: string = integrationId,
): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integrationRef,
      },
    },
    ctx.spaceId,
  );
  return item.id;
}

/** A connection naming no integration at all. The key is absent rather than
 *  null, which is the shape the resolver meets when nothing was named. */
async function createOrphanConnection(): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
      },
    },
    ctx.spaceId,
  );
  return item.id;
}

async function issueLease(
  connectionId: string,
  overrides: {
    capability_id?: string;
    ttl_seconds?: number;
    scopes?: string[];
  } = {},
): Promise<Response> {
  return request(ctx.app, "POST", `/connections/${connectionId}/lease-tokens`, {
    key: ctx.spaceKey,
    body: {
      capability_id: overrides.capability_id ?? "drive.upload",
      ttl_seconds: overrides.ttl_seconds,
      scopes: overrides.scopes,
    },
  });
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

describe("POST /connections/:id/lease-tokens — capability gating", () => {
  it("issues a lease for a manifest-declared 'leased' capability", async () => {
    const connectionId = await createConnection();
    const res = await issueLease(connectionId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedConnectionLeasedToken;
    expect(body.capability_id).toBe("drive.upload");
    expect(body.connection_id).toBe(connectionId);
    expect(typeof body.lease_token).toBe("string");
    expect(body.lease_token).toMatch(/^marfa_lt_/);
    const row = await ctx.storage.connectionLeasedTokens.get(body.id);
    expect(row).not.toBeNull();
    expect(row?.lease_token_hash).toBe(sha256(body.lease_token));
    expect(row?.lease_token_hash).not.toBe(body.lease_token);
  });

  it("rejects a capability declared as 'proxy' with 422", async () => {
    const connectionId = await createConnection();
    const res = await issueLease(connectionId, {
      capability_id: "drive.read",
    });
    expect(res.status).toBe(422);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("lease_capability_not_declared");
  });

  it("rejects a capability not in oauth_requirements at all with 422", async () => {
    const connectionId = await createConnection();
    const res = await issueLease(connectionId, {
      capability_id: "unknown.capability",
    });
    expect(res.status).toBe(422);
  });

  it("rejects ttl_seconds above the route ceiling (3600s)", async () => {
    const connectionId = await createConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens`,
      {
        key: ctx.spaceKey,
        body: {
          capability_id: "drive.upload",
          ttl_seconds: 7200,
        },
      },
    );
    // Zod-level ceiling — surfaces as 400 validation_error.
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const connectionId = await createConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens`,
      {
        body: {
          capability_id: "drive.upload",
        },
      },
    );
    expect(res.status).toBe(401);
  });

  it("rejects when the connection has no integration_ref", async () => {
    const orphan = await createOrphanConnection();
    const res = await issueLease(orphan);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_required_field");
  });

  it("gates capabilities via integration_ref-resolved manifest", async () => {
    // 1. Register the integration.
    const regRes = await request(ctx.app, "POST", "/integrations", {
      key: ctx.operatorKey,
      body: { manifest: { ...VALID_MANIFEST, name: "acme/lease-via-ref" } },
    });
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { id: string };

    // 2. Connection bound to the registered integration.
    const connectionId = await createConnection(reg.id);

    // 3. Issue lease with NO manifest in body — resolved server-side.
    const ok = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens`,
      {
        key: ctx.spaceKey,
        body: { capability_id: "drive.upload" },
      },
    );
    expect(ok.status).toBe(201);

    // 4. Reject a capability not declared by the resolved manifest.
    const denied = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens`,
      {
        key: ctx.spaceKey,
        body: { capability_id: "not.declared" },
      },
    );
    expect(denied.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// The credential a running integration actually holds
// ---------------------------------------------------------------------------

/** One space holding two installed connections, so a credential minted
 *  for one is space-legal against the other and only the identity
 *  binding separates them. */
async function spaceWithTwoConnections(): Promise<{
  connectionA: string;
  connectionB: string;
}> {
  if (!ctx.storage.spaces) {
    throw new Error("hosted identity test needs a spaces store");
  }
  const space = await ctx.storage.spaces.create(
    `lease-identity-${Math.random().toString(36).slice(2, 8)}`,
  );
  const suffix = Math.random().toString(36).slice(2, 8);
  const rawKey = `marfa_k1_test_lease_ident_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `lease-ident-${suffix}`,
      source: `lease-ident-${suffix}`,
      space_permissions: ["space.connections"],
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(rawKey, TEST_API_KEY_SALT),
    space.id,
  );
  const install = async (): Promise<string> => {
    const res = await request(ctx.app, "POST", "/connections/install", {
      key: rawKey,
      body: { integration_id: integrationId },
    });
    if (res.status !== 201) {
      throw new Error(
        `install failed: ${String(res.status)} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { connection_id: string };
    return body.connection_id;
  };
  return { connectionA: await install(), connectionB: await install() };
}

/**
 * These mint through `mintLocalRuntimeCredential`, the only path that
 * produces a credential a dispatch can present, rather than building a
 * row by hand and keeping the raw key.
 *
 * The distinction is the whole point of the cases. A hand-built fixture
 * can be given any `source` the author likes, so it will satisfy a gate
 * that tests one, and it proved a permissive behavior no caller could
 * reach: the real mint stamps `source: local-runtime:<id>:<suffix>` with
 * a random suffix, and the credential holds no space permission and is
 * not an operator key, so a fixture with a chosen source stands in for
 * nothing a dispatch can actually present.
 */
describe("integration runtime credential", () => {
  it("issues a lease when called with the connection's own runtime credential", async () => {
    const connectionId = await createConnection();
    const credential = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens`,
      {
        key: credential.api_key,
        body: { capability_id: "drive.upload" },
      },
    );
    expect(res.status).toBe(201);
  });

  it("revokes a lease on its own connection with its own runtime credential", async () => {
    const connectionId = await createConnection();
    const credential = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
    );
    const created = (await (
      await issueLease(connectionId)
    ).json()) as CreatedConnectionLeasedToken;

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens/${created.id}/revoke`,
      { key: credential.api_key },
    );
    expect(res.status).toBe(200);
  });

  /**
   * The identity gate, which is the only refusal a runtime credential can
   * now reach here.
   *
   * This used to sit beside a space-less case that proved the handler's
   * defense-in-depth space fence instead. That case is gone: a connection
   * with no space cannot be minted a runtime credential at all, so no
   * credential exists that could arrive space-less and be refused by the
   * fence. The fence stays in the handler, and nothing short of a hand-built
   * row can exercise it.
   *
   * Both connections live in one space and the credential carries that
   * space, so the only thing left that can refuse is the `connection_id`
   * binding.
   */
  it("refuses a runtime credential reaching a sibling connection in its own space", async () => {
    const { connectionA, connectionB } = await spaceWithTwoConnections();
    const credential = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionA,
    );

    const own = await request(
      ctx.app,
      "POST",
      `/connections/${connectionA}/lease-tokens`,
      { key: credential.api_key, body: { capability_id: "drive.upload" } },
    );
    expect(own.status).toBe(201);

    const sibling = await request(
      ctx.app,
      "POST",
      `/connections/${connectionB}/lease-tokens`,
      { key: credential.api_key, body: { capability_id: "drive.upload" } },
    );
    expect(sibling.status).toBe(403);
    const body = (await sibling.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      "Caller cannot manage leased tokens on this connection",
    );
  });
});

// ---------------------------------------------------------------------------
// List + revoke
// ---------------------------------------------------------------------------

describe("GET /connections/:id/lease-tokens & revoke", () => {
  it("lists active leases (excluding revoked + expired)", async () => {
    const connectionId = await createConnection();
    const a = (await (
      await issueLease(connectionId)
    ).json()) as CreatedConnectionLeasedToken;
    const b = (await (
      await issueLease(connectionId)
    ).json()) as CreatedConnectionLeasedToken;

    const revoke = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens/${a.id}/revoke`,
      { key: ctx.spaceKey },
    );
    expect(revoke.status).toBe(200);

    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/lease-tokens`,
      { key: ctx.spaceKey },
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { leases: ConnectionLeasedToken[] };
    const ids = body.leases.map((l) => l.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });

  it("returns 404 when revoking a lease that doesn't exist", async () => {
    const connectionId = await createConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens/does-not-exist/revoke`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

describe("POST /lease-tokens/validate", () => {
  it("returns active=true with metadata for a fresh lease", async () => {
    const connectionId = await createConnection();
    const created = (await (
      await issueLease(connectionId, { scopes: ["files.write"] })
    ).json()) as CreatedConnectionLeasedToken;

    const res = await request(ctx.app, "POST", "/lease-tokens/validate", {
      body: { lease_token: created.lease_token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LeaseTokenIntrospection;
    expect(body.active).toBe(true);
    expect(body.connection_id).toBe(connectionId);
    expect(body.capability_id).toBe("drive.upload");
    expect(body.scopes).toEqual(["files.write"]);
  });

  it("returns active=false for an unknown bearer", async () => {
    const res = await request(ctx.app, "POST", "/lease-tokens/validate", {
      body: { lease_token: "marfa_lt_does_not_exist" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LeaseTokenIntrospection;
    expect(body.active).toBe(false);
    expect(body.connection_id).toBeUndefined();
  });

  it("returns active=false for a revoked lease", async () => {
    const connectionId = await createConnection();
    const created = (await (
      await issueLease(connectionId)
    ).json()) as CreatedConnectionLeasedToken;
    await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens/${created.id}/revoke`,
      { key: ctx.spaceKey },
    );
    const res = await request(ctx.app, "POST", "/lease-tokens/validate", {
      body: { lease_token: created.lease_token },
    });
    const body = (await res.json()) as LeaseTokenIntrospection;
    expect(body.active).toBe(false);
  });

  it("returns active=false for an expired lease", async () => {
    const connectionId = await createConnection();
    // Create a lease, then mutate its expires_at directly to the past.
    const created = (await (
      await issueLease(connectionId)
    ).json()) as CreatedConnectionLeasedToken;
    const sqliteRun = (
      ctx.storage as unknown as {
        __sqliteRun?: (q: string, p: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    if (sqliteRun) {
      await sqliteRun(
        "UPDATE connection_leased_tokens SET expires_at = ? WHERE id = ?",
        ["2020-01-01T00:00:00.000Z", created.id],
      );
    } else {
      const pgClient = (
        ctx.storage as unknown as {
          __pgClient?: (q: string, p: unknown[]) => Promise<unknown[]>;
        }
      ).__pgClient;
      if (pgClient) {
        await pgClient(
          "UPDATE connection_leased_tokens SET expires_at = $1 WHERE id = $2",
          ["2020-01-01T00:00:00.000Z", created.id],
        );
      }
    }
    const res = await request(ctx.app, "POST", "/lease-tokens/validate", {
      body: { lease_token: created.lease_token },
    });
    const body = (await res.json()) as LeaseTokenIntrospection;
    expect(body.active).toBe(false);
  });
});

describe("POST /connections/:id/lease-tokens — space scoping", () => {
  // Mirror of the inbound-webhooks space-scoping cases: the manifest
  // resolver must see the platform-scoped integration item from a
  // space-scoped caller, and the lease row must land in the
  // CONNECTION's space so the fenced list, revoke, and uninstall-sweep
  // lookups can reach it whoever issued it.
  async function spaceScopedConnection(): Promise<{
    spaceId: string;
    spaceKey: string;
    connectionId: string;
  }> {
    if (!ctx.storage.spaces) {
      throw new Error("space-scoping tests need a spaces store");
    }
    const space = await ctx.storage.spaces.create(
      `lease-scope-${Math.random().toString(36).slice(2, 8)}`,
    );
    const suffix = Math.random().toString(36).slice(2, 8);
    const rawKey = `marfa_k1_test_lease_spacekey_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `lease-scope-spacekey-${suffix}`,
        source: `lease-scope-spacekey-${suffix}`,
        space_permissions: ["space.connections"],
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(rawKey, TEST_API_KEY_SALT),
      space.id,
    );
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

  it("a space key holding space.connections issues a lease against a platform-scoped integration item", async () => {
    const { spaceId, spaceKey, connectionId } = await spaceScopedConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens`,
      { key: spaceKey, body: { capability_id: "drive.upload" } },
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedConnectionLeasedToken;
    expect(created.space_id).toBe(spaceId);
  });

  it("refuses the one space-less caller, and the row lands in the connection's space", async () => {
    const { spaceId, spaceKey, connectionId } = await spaceScopedConnection();

    // The operator key is the only credential that carries no space, and
    // this door refuses it for that: a lease row has to live in the
    // connection's space or the fenced list and revoke lookups, and the
    // uninstall sweep, never reach it. The door used to admit the operator
    // key past the space guard and stamp the connection's space to cover
    // the divergence; it holds no `space.connections`, so it was refused a
    // few lines later anyway and the divergence never existed.
    const asOperator = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens`,
      { key: ctx.operatorKey, body: { capability_id: "drive.upload" } },
    );
    expect(asOperator.status).toBe(403);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens`,
      { key: spaceKey, body: { capability_id: "drive.upload" } },
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedConnectionLeasedToken;
    expect(created.space_id).toBe(spaceId);
    // The fenced enumeration the uninstall sweep and the space's own
    // list route use must find the row.
    const rows =
      await ctx.storage.connectionLeasedTokens.listActiveByConnection(
        connectionId,
        spaceId,
      );
    expect(rows.map((r) => r.id)).toContain(created.id);
  });
});
