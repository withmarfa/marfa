import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type {
  CreatedConnectionLeasedToken,
  ConnectionLeasedToken,
  LeaseTokenIntrospection,
} from "@mymehq/shared";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;
/** Registered system.integration id pointing at VALID_MANIFEST. */
let integrationId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  // T-022: lease-token capability gating now resolves the manifest from
  // the connection's integration_ref. Register one up front.
  const reg = await request(ctx.app, "POST", "/integrations", {
    key: ctx.adminKey,
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

interface ItemResponse {
  item: { id: string; type: string };
}

const VALID_MANIFEST = {
  name: "acme.connector",
  version: "1.0.0",
  publisher: "Acme",
  description: "Demo connector",
  direction: "both" as const,
  triggers: [{ type: "webhook" as const }],
  target_types: ["core.note"],
  runtime_compatibility: ["hosted" as const],
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
  manifest_schema_version: "1.0.0",
};

async function createConnection(): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integrationId,
      },
    },
  });
  if (res.status !== 201) {
    const txt = await res.text();
    throw new Error(`createConnection failed: ${String(res.status)} ${txt}`);
  }
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

async function issueLease(
  connectionId: string,
  overrides: {
    capability_id?: string;
    ttl_seconds?: number;
    scopes?: string[];
  } = {},
): Promise<Response> {
  return request(ctx.app, "POST", `/connections/${connectionId}/lease-token`, {
    key: ctx.adminKey,
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

describe("POST /connections/:id/lease-token — capability gating", () => {
  it("issues a lease for a manifest-declared 'leased' capability", async () => {
    const connectionId = await createConnection();
    const res = await issueLease(connectionId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedConnectionLeasedToken;
    expect(body.capability_id).toBe("drive.upload");
    expect(body.connection_id).toBe(connectionId);
    expect(typeof body.lease_token).toBe("string");
    expect(body.lease_token).toMatch(/^myme_lt_/);
    // Plaintext is not stored — the storage row holds a SHA-256 hash.
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
      `/connections/${connectionId}/lease-token`,
      {
        key: ctx.adminKey,
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
      `/connections/${connectionId}/lease-token`,
      {
        body: {
          capability_id: "drive.upload",
        },
      },
    );
    expect(res.status).toBe(401);
  });

  it("rejects when the connection has no integration_ref (T-022)", async () => {
    const orphanRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
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
    const res = await issueLease(orphan.item.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_required_field");
  });

  // Layer 2 PR 2: preferred path — capability gating against the
  // manifest persisted under integration_ref (no inline manifest in
  // the request body).
  it("gates capabilities via integration_ref-resolved manifest", async () => {
    // 1. Register the integration.
    const regRes = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: { ...VALID_MANIFEST, name: "acme.lease-via-ref" } },
    });
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { id: string };

    // 2. Connection bound to the registered integration.
    const conn = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
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

    // 3. Issue lease with NO manifest in body — resolved server-side.
    const ok = await request(
      ctx.app,
      "POST",
      `/connections/${connBody.item.id}/lease-token`,
      {
        key: ctx.adminKey,
        body: { capability_id: "drive.upload" },
      },
    );
    expect(ok.status).toBe(201);

    // 4. Reject a capability not declared by the resolved manifest.
    const denied = await request(
      ctx.app,
      "POST",
      `/connections/${connBody.item.id}/lease-token`,
      {
        key: ctx.adminKey,
        body: { capability_id: "not.declared" },
      },
    );
    expect(denied.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// T-018 — runtime credential (integration: source) can manage own leases
// ---------------------------------------------------------------------------

describe("connector runtime credential — integration: source (T-018)", () => {
  it("issues a lease when called with the connection's runtime credential", async () => {
    const connectionId = await createConnection();
    // Mint a runtime credential exactly like the install pipeline does:
    // source = `integration:<connectionId>`, connection_id stamped.
    const rawKey = `myme_k1_runtime_test_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.createRuntimeCredential(
      {
        label: "test-runtime-cred",
        source: `integration:${connectionId}`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: {},
        edge_permissions: {},
        connection_id: connectionId,
      },
      keyHash,
      undefined,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-token`,
      {
        key: rawKey,
        body: { capability_id: "drive.upload" },
      },
    );
    // Pre-T-018 the access check matched only `oauth:<connectionId>` —
    // the install pipeline's `integration:<connectionId>` source got
    // 403'd. Post-fix the runtime credential is admitted.
    expect(res.status).toBe(201);
  });

  it("refuses a runtime credential bound to a different connection", async () => {
    const connectionA = await createConnection();
    const connectionB = await createConnection();

    // Runtime credential bound to connection A.
    const rawKey = `myme_k1_runtime_otherconn_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.createRuntimeCredential(
      {
        label: "test-runtime-cred-other",
        source: `integration:${connectionA}`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: {},
        edge_permissions: {},
        connection_id: connectionA,
      },
      keyHash,
      undefined,
    );

    // Try to issue a lease on connection B — must be refused.
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionB}/lease-token`,
      {
        key: rawKey,
        body: { capability_id: "drive.upload" },
      },
    );
    expect(res.status).toBe(403);
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

    // Revoke one.
    const revoke = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/lease-tokens/${a.id}/revoke`,
      { key: ctx.adminKey },
    );
    expect(revoke.status).toBe(200);

    const list = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/lease-tokens`,
      { key: ctx.adminKey },
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
      { key: ctx.adminKey },
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
      body: { lease_token: "myme_lt_does_not_exist" },
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
      { key: ctx.adminKey },
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
    // Mutate via storage interface directly so we don't need a route.
    // The store has no setter, so we issue a SQLite/PG raw query through
    // the storage's escape hatch where available.
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
