import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import {
  encryptSecret,
  decryptSecret,
  SECRET_INFO,
} from "../crypto/secret-encryption.js";

let ctx: TestContext;
let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
  ctx = await createTestContext();
  realFetch = globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await ctx.cleanup();
});

interface ItemResponse {
  item: { id: string; type: string };
}

async function createCredential(
  override?: Partial<{
    upstream_base_url: string;
    oauth_token_url: string;
    oauth_client_id: string;
    oauth_client_secret: string;
  }>,
): Promise<string> {
  const cfg = {
    upstream_base_url: "https://upstream.test",
    oauth_token_url: "https://upstream.test/oauth/token",
    oauth_client_id: "test-client",
    oauth_client_secret: "test-secret",
    ...override,
  };
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.credential",
      properties: {
        label: "test-cred",
        kind: "oauth_token",
        oauth_provider_config: {
          upstream_base_url: cfg.upstream_base_url,
          oauth_token_url: cfg.oauth_token_url,
          oauth_client_id: cfg.oauth_client_id,
        },
        secret_encrypted: encryptSecret(
          cfg.oauth_client_secret,
          SECRET_INFO.connectionOauthToken,
        ),
      },
    },
  });
  if (res.status !== 201) {
    const txt = await res.text();
    throw new Error(`createCredential failed: ${String(res.status)} ${txt}`);
  }
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

/**
 * Build a connection backed by a freshly-minted system.credential. The
 * proxy reads OAuth config from the credential item, not from inline
 * `configuration`, so every test connection must reference a credential item.
 */
async function createConnection(opts?: {
  credentialId?: string;
  /**
   * Override the OAuth config baked into the auto-created credential.
   * Ignored when `credentialId` is supplied.
   */
  credentialOverride?: Partial<{
    upstream_base_url: string;
    oauth_token_url: string;
    oauth_client_id: string;
    oauth_client_secret: string;
  }>;
  skipCredential?: boolean;
}): Promise<string> {
  const properties: Record<string, unknown> = {
    kind: "integration",
    status: "active",
    granted_at: new Date().toISOString(),
    integration_ref: "acme.demo",
  };
  if (!opts?.skipCredential) {
    properties.credential_ref =
      opts?.credentialId ?? (await createCredential(opts?.credentialOverride));
  }
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.connection",
      properties,
    },
  });
  if (res.status !== 201) {
    const txt = await res.text();
    throw new Error(`createConnection failed: ${String(res.status)} ${txt}`);
  }
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

async function seedToken(
  connectionId: string,
  opts: {
    accessPlain?: string;
    refreshPlain?: string | null;
    expiresInSec?: number;
  } = {},
): Promise<void> {
  const accessPlain = opts.accessPlain ?? "access-original";
  // `"refreshPlain" in opts` distinguishes "absent" (use default) from explicit `null` (no refresh token).
  const refreshPlain =
    "refreshPlain" in opts ? opts.refreshPlain : "refresh-original";
  const expiresInSec = opts.expiresInSec ?? 3600;
  await ctx.storage.connectionOauthTokens.upsert({
    connection_id: connectionId,
    access_token_encrypted: encryptSecret(
      accessPlain,
      SECRET_INFO.connectionOauthToken,
    ),
    refresh_token_encrypted:
      refreshPlain == null
        ? null
        : encryptSecret(refreshPlain, SECRET_INFO.connectionOauthToken),
    expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    scopes: ["read", "write"],
  });
}

/**
 * Install a stub `globalThis.fetch` whose responses come from the
 * supplied script. Each call consumes one entry. Throws if the script
 * is exhausted to surface accidental over-fetches.
 */
type FetchHandler = (req: { url: string; init: RequestInit }) => Response;

function installFetchScript(handlers: FetchHandler[]): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (...args: Parameters<typeof fetch>) => {
    const arg0 = args[0];
    const url =
      typeof arg0 === "string"
        ? arg0
        : arg0 instanceof URL
          ? arg0.toString()
          : arg0.url;
    const init = args[1] ?? {};
    const next = handlers[state.calls];
    if (!next) {
      throw new Error(
        `Unexpected fetch call #${String(state.calls)} to ${url}`,
      );
    }
    state.calls += 1;
    return Promise.resolve(next({ url, init }));
  };
  return state;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Storage round-trip
// ---------------------------------------------------------------------------

describe("connection_oauth_tokens — storage round-trip", () => {
  it("encrypts at rest and round-trips through decryptSecret", async () => {
    const connectionId = await createConnection();
    const plaintext = "very-secret-access-token-xyz";
    await ctx.storage.connectionOauthTokens.upsert({
      connection_id: connectionId,
      access_token_encrypted: encryptSecret(
        plaintext,
        SECRET_INFO.connectionOauthToken,
      ),
      refresh_token_encrypted: null,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ["a", "b"],
    });
    const row = await ctx.storage.connectionOauthTokens.get(connectionId);
    expect(row).not.toBeNull();
    if (!row) throw new Error("row missing");
    expect(row.access_token_encrypted).not.toContain(plaintext);
    expect(
      decryptSecret(
        row.access_token_encrypted,
        SECRET_INFO.connectionOauthToken,
      ),
    ).toBe(plaintext);
  });

  it("upsert overwrites in place (single row per connection)", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId, { accessPlain: "first" });
    await seedToken(connectionId, { accessPlain: "second" });
    const row = await ctx.storage.connectionOauthTokens.get(connectionId);
    if (!row) throw new Error("row missing");
    expect(
      decryptSecret(
        row.access_token_encrypted,
        SECRET_INFO.connectionOauthToken,
      ),
    ).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Proxy route — happy path + auth gate
// ---------------------------------------------------------------------------

describe("POST /connections/:id/proxy/* — happy path", () => {
  it("forwards to upstream with bearer token and passes through response", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId);

    const fetchState = installFetchScript([
      ({ url, init }) => {
        expect(url).toBe("https://upstream.test/api/v1/widgets?q=foo");
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer access-original");
        return jsonResponse(200, { ok: true, items: [] });
      },
    ]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/api/v1/widgets?q=foo`,
      {
        key: ctx.adminKey,
        body: { hello: "world" },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(fetchState.calls).toBe(1);
  });

  it("returns 401 when the caller is unauthenticated", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId);
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/anything`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the connection has no token row", async () => {
    const connectionId = await createConnection();
    // intentionally no seedToken
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/api`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });

  it("resolves OAuth config via credential_ref when set (preferred path)", async () => {
    // 1. Create a system.credential with the encrypted client secret.
    const credRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.credential",
        properties: {
          label: "test-cred",
          kind: "oauth_token",
          oauth_provider_config: {
            upstream_base_url: "https://via-credential.test",
            oauth_token_url: "https://via-credential.test/oauth/token",
            oauth_client_id: "via-cred-client",
          },
          secret_encrypted: encryptSecret(
            "via-cred-secret",
            SECRET_INFO.connectionOauthToken,
          ),
        },
      },
    });
    const credBody = (await credRes.json()) as ItemResponse;

    // 2. Connection with credential_ref + NO inline OAuth config in
    //    `configuration`. The dual-read path should pick the credential.
    const connRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: "acme.demo",
          credential_ref: credBody.item.id,
          configuration: {},
        },
      },
    });
    const connBody = (await connRes.json()) as ItemResponse;
    const connectionId = connBody.item.id;
    await seedToken(connectionId);

    const fetchState = installFetchScript([
      ({ url }) => {
        // The upstream URL came from the credential, not inline config.
        expect(url).toBe("https://via-credential.test/api/v1/widgets");
        return jsonResponse(200, { ok: true, source: "credential" });
      },
    ]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/api/v1/widgets`,
      { key: ctx.adminKey, body: {} },
    );
    expect(res.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Refresh flows
// ---------------------------------------------------------------------------

describe("POST /connections/:id/proxy/* — refresh on 401", () => {
  it("refreshes after upstream 401, retries once, returns success", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId, {
      accessPlain: "stale-access",
      refreshPlain: "the-refresh",
    });

    installFetchScript([
      // First upstream call → 401
      () => jsonResponse(401, { error: "invalid_token" }),
      // Refresh exchange
      ({ url, init }) => {
        expect(url).toBe("https://upstream.test/oauth/token");
        if (typeof init.body !== "string") {
          throw new Error("expected refresh body to be a string");
        }
        expect(init.body).toContain("grant_type=refresh_token");
        expect(init.body).toContain("refresh_token=the-refresh");
        return jsonResponse(200, {
          access_token: "fresh-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      },
      // Retry with new bearer
      ({ init }) => {
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer fresh-access");
        return jsonResponse(200, { ok: true });
      },
    ]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/things`,
      { key: ctx.adminKey, body: { x: 1 } },
    );
    expect(res.status).toBe(200);

    // Verify rotation persisted + previous_refresh_hash set.
    const row = await ctx.storage.connectionOauthTokens.get(connectionId);
    if (!row) throw new Error("row missing");
    expect(
      decryptSecret(
        row.access_token_encrypted,
        SECRET_INFO.connectionOauthToken,
      ),
    ).toBe("fresh-access");
    if (!row.refresh_token_encrypted) throw new Error("refresh missing");
    expect(
      decryptSecret(
        row.refresh_token_encrypted,
        SECRET_INFO.connectionOauthToken,
      ),
    ).toBe("rotated-refresh");
    expect(row.previous_refresh_hash).toBe(sha256Hex("the-refresh"));
  });

  it("refresh fail (invalid_grant) flips runtime_status + emits system.activity + 401", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId, {
      accessPlain: "stale",
      refreshPlain: "doomed-refresh",
    });

    installFetchScript([
      () => jsonResponse(401, { error: "invalid_token" }),
      () => jsonResponse(400, { error: "invalid_grant" }),
    ]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/things`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oauth_proxy_reauth_required");

    // Connection's runtime_status flipped.
    const conn = await ctx.storage.items.get(connectionId);
    if (!conn) throw new Error("connection missing");
    expect(conn.properties.runtime_status).toBe("reauth_required");

    // Activity row emitted with action_required severity.
    const activities = await ctx.storage.items.list({
      type: "system.activity",
      limit: 50,
    });
    const matched = activities.data.find(
      (it) => it.properties.connection_id === connectionId,
    );
    expect(matched).toBeDefined();
    expect(matched?.properties.severity).toBe("action_required");
  });

  it("returns 401 + reauth_required when no refresh token is on file", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId, {
      accessPlain: "stale",
      refreshPlain: null,
    });

    installFetchScript([() => jsonResponse(401, { error: "invalid_token" })]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/things`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(401);

    const conn = await ctx.storage.items.get(connectionId);
    expect(conn?.properties.runtime_status).toBe("reauth_required");
  });
});

// ---------------------------------------------------------------------------
// Proactive refresh
// ---------------------------------------------------------------------------

describe("POST /connections/:id/proxy/* — proactive refresh", () => {
  it("refreshes before issuing the call when expires_at is inside the leeway window", async () => {
    const connectionId = await createConnection();
    // Expire in 10s — well inside 60s leeway.
    await seedToken(connectionId, {
      accessPlain: "about-to-expire",
      refreshPlain: "still-good",
      expiresInSec: 10,
    });

    installFetchScript([
      // Refresh first
      ({ url }) => {
        expect(url).toBe("https://upstream.test/oauth/token");
        return jsonResponse(200, {
          access_token: "renewed-access",
          refresh_token: "still-good",
          expires_in: 3600,
        });
      },
      // Then the actual call
      ({ init }) => {
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer renewed-access");
        return jsonResponse(200, { ok: true });
      },
    ]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/api`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
  });

  it("does NOT refresh when expires_at is comfortably in the future", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId, {
      accessPlain: "current",
      refreshPlain: "rt",
      expiresInSec: 3600,
    });

    const fetchState = installFetchScript([
      // Single call only — no refresh.
      ({ init }) => {
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer current");
        return jsonResponse(200, { ok: true });
      },
    ]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/api`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("POST /connections/:id/proxy/* — audit", () => {
  it("writes an audit row on every call (success and failure)", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId);

    installFetchScript([
      () => jsonResponse(200, { ok: true }),
      () => jsonResponse(500, { error: "upstream-down" }),
    ]);

    await request(ctx.app, "POST", `/connections/${connectionId}/proxy/path1`, {
      key: ctx.adminKey,
    });
    await request(ctx.app, "POST", `/connections/${connectionId}/proxy/path2`, {
      key: ctx.adminKey,
    });

    // Allow async audit log writes to flush.
    await vi.waitFor(async () => {
      const audit = await ctx.storage.audit.list({
        action: "connection_proxy.call",
        limit: 50,
      });
      const callRows = audit.data.filter((r) => r.resource_id === connectionId);
      expect(callRows.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Misconfiguration
// ---------------------------------------------------------------------------

describe("POST /connections/:id/proxy/* — misconfiguration", () => {
  it("returns 422 OAUTH_PROXY_UPSTREAM_INVALID when credential_ref is missing", async () => {
    const connectionId = await createConnection({ skipCredential: true });
    await seedToken(connectionId);

    const proxyRes = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/path`,
      { key: ctx.adminKey },
    );
    expect(proxyRes.status).toBe(422);
    const err = (await proxyRes.json()) as { error: { code: string } };
    expect(err.error.code).toBe("oauth_proxy_upstream_invalid");
  });

  it("returns 422 when credential_ref doesn't resolve to a system.credential", async () => {
    const connectionId = await createConnection({
      credentialId: "0192abcd-ef00-7000-8000-000000000099",
    });
    await seedToken(connectionId);

    const proxyRes = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/path`,
      { key: ctx.adminKey },
    );
    expect(proxyRes.status).toBe(422);
    const err = (await proxyRes.json()) as { error: { code: string } };
    expect(err.error.code).toBe("oauth_proxy_upstream_invalid");
  });

  // Defence-in-depth: the install pipeline already enforces same-tenant
  // `credential_ref` at install-time, so any legitimately-installed
  // connection points at a credential in its own tenant. If a future
  // bypass of that validation ever lands a cross-tenant `credential_ref`,
  // the proxy MUST refuse to decrypt — otherwise an attacker who can
  // write a connection row in their own tenant could exfiltrate another
  // tenant's OAuth secret.
  it("refuses to resolve a cross-tenant credential_ref", async () => {
    if (!ctx.storage.tenants) return;
    const tenantA = await ctx.storage.tenants.create("t235-proxy-A");
    const tenantB = await ctx.storage.tenants.create("t235-proxy-B");

    // Admin (not platform) is tenant-bounded; the cross-tenant fence fires inside readOAuthConfig,
    // after requireConnectionProxyAccess passes.
    const suffix = Math.random().toString(36).slice(2, 8);
    const rawKey = `marfa_k1_t235_admin_a_${suffix}`;
    const hash = hashApiKey(rawKey, TEST_API_KEY_SALT);
    await ctx.storage.keys.create(
      {
        label: `t235-admin-a-${suffix}`,
        source: `t235-admin-a-${suffix}`,
        role: "admin",
        default_tier: "library",
        is_platform: false,
      },
      hash,
      tenantA.id,
    );

    const crossCred = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: "tenant-B-secret",
          kind: "oauth_token",
          oauth_provider_config: {
            upstream_base_url: "https://upstream.test",
            oauth_token_url: "https://upstream.test/oauth/token",
            oauth_client_id: "tenant-b-client",
          },
          secret_encrypted: encryptSecret(
            "tenant-b-secret-do-not-leak",
            SECRET_INFO.connectionOauthToken,
          ),
        },
      },
      tenantB.id,
    );

    // Connection lives in tenant A but its credential_ref points at
    // the tenant-B credential. Build through storage so we bypass the
    // install pipeline (the bypass IS the scenario we're guarding).
    const crossConn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: "acme.demo",
          credential_ref: crossCred.id,
        },
      },
      tenantA.id,
    );

    const proxyRes = await request(
      ctx.app,
      "POST",
      `/connections/${crossConn.id}/proxy/path`,
      { key: rawKey },
    );
    // Fence holds: credential lookup misses (wrong tenant) → 422, not 200 with tenant-B secret.
    expect(proxyRes.status).toBe(422);
    const err = (await proxyRes.json()) as { error: { code: string } };
    expect(err.error.code).toBe("oauth_proxy_upstream_invalid");
  });
});

// ---------------------------------------------------------------------------
// Runtime-credential proxy access
// ---------------------------------------------------------------------------

describe("POST /connections/:id/proxy/* — runtime credentials", () => {
  it("accepts runtime credentials minted for the connection (is_runtime_credential + connection_id match)", async () => {
    const connectionId = await createConnection();
    await seedToken(connectionId);

    const rawKey = "marfa_k1_" + "f".repeat(64);
    const keyHash = hashApiKey(rawKey, TEST_API_KEY_SALT);
    await ctx.storage.keys.createRuntimeCredential(
      {
        label: "test runtime credential",
        source: `integration:${connectionId}`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: { "connection.runtime": "write" },
        edge_permissions: {},
        connection_id: connectionId,
      },
      keyHash,
      undefined,
    );

    const fetchState = installFetchScript([
      ({ url, init }) => {
        expect(url).toBe("https://upstream.test/whatever");
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer access-original");
        return jsonResponse(200, { ok: true });
      },
    ]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/whatever`,
      { key: rawKey },
    );

    expect(res.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });

  it("rejects runtime credentials bound to a different connection (cross-connection probe)", async () => {
    const connectionA = await createConnection();
    const connectionB = await createConnection();
    await seedToken(connectionA);

    const rawKey = "marfa_k1_" + "e".repeat(64);
    const keyHash = hashApiKey(rawKey, TEST_API_KEY_SALT);
    await ctx.storage.keys.createRuntimeCredential(
      {
        label: "wrong-connection runtime credential",
        source: `integration:${connectionB}`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: { "connection.runtime": "write" },
        edge_permissions: {},
        connection_id: connectionB,
      },
      keyHash,
      undefined,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionA}/proxy/whatever`,
      { key: rawKey },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// kind: api_token branch
// ---------------------------------------------------------------------------

async function createApiTokenCredential(opts?: {
  upstream_base_url?: string;
  api_token?: string;
  auth_scheme?: string;
}): Promise<string> {
  const cfg = {
    upstream_base_url: "https://upstream.test",
    api_token: "td-test-token-deadbeef",
    ...opts,
  };
  const apiTokenConfig: Record<string, unknown> = {
    upstream_base_url: cfg.upstream_base_url,
  };
  if (cfg.auth_scheme !== undefined) {
    apiTokenConfig.auth_scheme = cfg.auth_scheme;
  }
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.credential",
      properties: {
        label: "test-api-token-cred",
        kind: "api_token",
        api_token_config: apiTokenConfig,
        secret_encrypted: encryptSecret(
          cfg.api_token,
          SECRET_INFO.connectionOauthToken,
        ),
      },
    },
  });
  if (res.status !== 201) {
    throw new Error(`createApiTokenCredential failed: ${String(res.status)}`);
  }
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

async function createApiTokenConnection(opts?: {
  upstream_base_url?: string;
  api_token?: string;
  auth_scheme?: string;
}): Promise<string> {
  const credId = await createApiTokenCredential(opts);
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: "acme.demo-api-token",
        credential_ref: credId,
      },
    },
  });
  if (res.status !== 201) {
    throw new Error(`createApiTokenConnection failed: ${String(res.status)}`);
  }
  const body = (await res.json()) as ItemResponse;
  return body.item.id;
}

describe("POST /connections/:id/proxy/* — kind:api_token", () => {
  it("stamps the static bearer verbatim on the upstream call (no token row, no refresh)", async () => {
    const connectionId = await createApiTokenConnection({
      upstream_base_url: "https://api.todoist.com",
      api_token: "rd_td_static_token_xyz",
    });

    const fetchState = installFetchScript([
      ({ url, init }) => {
        expect(url).toBe("https://api.todoist.com/rest/v2/tasks");
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer rd_td_static_token_xyz");
        return jsonResponse(200, [{ id: "1", content: "hello" }]);
      },
    ]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/proxy/rest/v2/tasks`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });

  it("upstream 401 surfaces as reauth_required + system.activity action_required (no retry, no refresh)", async () => {
    const connectionId = await createApiTokenConnection({
      upstream_base_url: "https://api.todoist.com",
      api_token: "stale-static-token",
    });

    // Only ONE upstream call expected — no retry on 401 for static tokens.
    const fetchState = installFetchScript([
      () => jsonResponse(401, { error: "unauthorized" }),
    ]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/proxy/rest/v2/tasks`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oauth_proxy_reauth_required");
    expect(fetchState.calls).toBe(1);

    // Connection flipped to reauth_required.
    const conn = await ctx.storage.items.get(connectionId);
    expect(conn?.properties.runtime_status).toBe("reauth_required");

    // system.activity row emitted with action_required severity.
    const activities = await ctx.storage.items.list({
      type: "system.activity",
      limit: 50,
    });
    const matched = activities.data.find(
      (it) => it.properties.connection_id === connectionId,
    );
    expect(matched?.properties.severity).toBe("action_required");
  });

  it("does NOT require a connectionOauthTokens row to be present", async () => {
    // Distinct from the OAuth flow: kind:api_token reads everything it
    // needs from the credential row. No `seedToken` call here.
    const connectionId = await createApiTokenConnection({
      api_token: "no-token-row-needed",
    });

    installFetchScript([() => jsonResponse(200, { ok: true })]);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/proxy/things`,
      { key: ctx.adminKey, body: { x: 1 } },
    );
    expect(res.status).toBe(200);
  });

  it("audit row carries credential_kind: api_token", async () => {
    const connectionId = await createApiTokenConnection({
      api_token: "audit-trail-token",
    });

    installFetchScript([() => jsonResponse(200, { ok: true })]);

    await request(ctx.app, "GET", `/connections/${connectionId}/proxy/path`, {
      key: ctx.adminKey,
    });

    await vi.waitFor(async () => {
      const audit = await ctx.storage.audit.list({
        action: "connection_proxy.call",
        limit: 50,
      });
      const callRows = audit.data.filter(
        (r: { resource_id?: string | null }) => r.resource_id === connectionId,
      );
      expect(callRows.length).toBeGreaterThanOrEqual(1);
      const latest = callRows[callRows.length - 1];
      expect(
        (latest?.details as { credential_kind?: string } | undefined)
          ?.credential_kind,
      ).toBe("api_token");
    });
  });
});

// ---------------------------------------------------------------------------
// kind: api_token + auth_scheme
// ---------------------------------------------------------------------------

describe("POST /connections/:id/proxy/* — kind:api_token auth_scheme", () => {
  it("stamps `Authorization: Token <key>` when auth_scheme is 'Token' (Readwise)", async () => {
    const connectionId = await createApiTokenConnection({
      upstream_base_url: "https://readwise.io",
      api_token: "rw_static_token_xyz",
      auth_scheme: "Token",
    });

    const fetchState = installFetchScript([
      ({ url, init }) => {
        expect(url).toBe("https://readwise.io/api/v2/export/");
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Token rw_static_token_xyz");
        return jsonResponse(200, { results: [] });
      },
    ]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/proxy/api/v2/export/`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });

  it("stamps `Authorization: Bearer <key>` when auth_scheme is 'Bearer' (explicit default)", async () => {
    const connectionId = await createApiTokenConnection({
      api_token: "explicit_bearer",
      auth_scheme: "Bearer",
    });

    installFetchScript([
      ({ init }) => {
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer explicit_bearer");
        return jsonResponse(200, { ok: true });
      },
    ]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/proxy/anything`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
  });

  it("stamps `Authorization: Basic <key>` when auth_scheme is 'Basic'", async () => {
    const connectionId = await createApiTokenConnection({
      api_token: "preencoded_basic_token",
      auth_scheme: "Basic",
    });

    installFetchScript([
      ({ init }) => {
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Basic preencoded_basic_token");
        return jsonResponse(200, { ok: true });
      },
    ]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/proxy/anything`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
  });

  it("defaults to Bearer when api_token_config carries no auth_scheme", async () => {
    const connectionId = await createApiTokenConnection({
      api_token: "default_scheme_token",
      // auth_scheme deliberately omitted — no scheme set on credential.
    });

    installFetchScript([
      ({ init }) => {
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer default_scheme_token");
        return jsonResponse(200, { ok: true });
      },
    ]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/proxy/anything`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Per-connection upstream_base_url override
// ---------------------------------------------------------------------------

describe("POST /connections/:id/proxy/* — upstream_base_url_override", () => {
  it("routes via connection.properties.configuration.upstream_base_url_override when set, ignoring the credential's upstream_base_url", async () => {
    // Mint a credential whose upstream_base_url points at host A.
    const credentialId = await createCredential({
      upstream_base_url: "https://shared-host.test",
    });

    // Connect with credential_ref pointing at that credential, BUT set a
    // per-connection override pointing at host B. The proxy MUST route to
    // host B — that's the whole point of the override.
    const connRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: "google.contacts",
          credential_ref: credentialId,
          configuration: {
            upstream_base_url_override: "https://people.googleapis.com",
          },
        },
      },
    });
    expect(connRes.status).toBe(201);
    const connBody = (await connRes.json()) as ItemResponse;
    const connectionId = connBody.item.id;
    await seedToken(connectionId);

    const fetchState = installFetchScript([
      ({ url }) => {
        // Override wins — request lands at people.googleapis.com, not
        // shared-host.test (the credential's URL).
        expect(url).toBe("https://people.googleapis.com/people/me");
        return jsonResponse(200, { ok: true });
      },
    ]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/proxy/people/me`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });

  it("returns 422 OAUTH_PROXY_UPSTREAM_INVALID when override is malformed (fail loud, no silent fallback)", async () => {
    const credentialId = await createCredential({
      upstream_base_url: "https://shared-host.test",
    });
    const connRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: "google.contacts",
          credential_ref: credentialId,
          configuration: {
            upstream_base_url_override: "not-a-url",
          },
        },
      },
    });
    expect(connRes.status).toBe(201);
    const connBody = (await connRes.json()) as ItemResponse;
    const connectionId = connBody.item.id;
    await seedToken(connectionId);

    // No fetch should ever fire — the override is rejected before the
    // upstream URL is built.
    installFetchScript([]);

    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/proxy/people/me`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("oauth_proxy_upstream_invalid");
  });
});
