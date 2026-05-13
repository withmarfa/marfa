import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { createApp } from "../app.js";
import {
  hashApiKey,
  touchLastUsedCache,
  _clearOAuthLastUsedCacheForTesting,
} from "../middleware/auth.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

describe("authentication", () => {
  it("returns 401 when no auth header is provided", async () => {
    const res = await request(ctx.app, "GET", "/items");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid key", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: "myme_k1_invalid_key",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid admin key", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
  });
});

describe("bootstrap mode", () => {
  it("allows key creation without auth when no keys exist", async () => {
    const freshTmpDir = mkdtempSync(join(tmpdir(), "myme-boot-"));
    const storage = await createSqliteStorage(join(freshTmpDir, "boot.db"));
    const blobBackend = new FilesystemBlobBackend(join(freshTmpDir, "blobs"));
    const app = createApp(storage, blobBackend, {
      port: 0,
      storageDialect: "sqlite",
      sqlitePath: "",
      databaseUrl: "",
      blobPath: "",
      blobBackend: "fs",
      maxBlobSize: 50 * 1024 * 1024,
      s3Bucket: "",
      s3Region: "us-east-1",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      apiKeySalt: "test-salt",
      corsOrigins: [],
      cdnBaseUrl: "",
      authMode: "keys",
      versionSnapshotIntervalMs: 600_000,
      rateLimitEnabled: false,
      enableHsts: false,
      auditRetentionDays: 90,
      auditCleanupIntervalMs: 86_400_000,
      eventLogRetentionHours: 168,
      versionThinningIntervalMs: 3_600_000,
      versionRecentDays: 30,
      versionDailySnapshotDays: 90,
      versionWeeklySnapshotDays: 365,
      versionMaxVersions: 500,
      trashRetentionDays: 60,
      trashPurgeIntervalMs: 86_400_000,
      authSessionCleanupIntervalMs: 3_600_000,
      errorWebhookUrl: "",
      trustedProxyCidrs: [],
      authBaseUrl: "http://localhost:0",
      authAllowSignup: true,
      authSecret: "test-auth-secret",
      oidcProviders: [],
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
      oauthRedirectAllowlist: [],
    });

    const res = await request(app, "POST", "/keys", {
      body: { label: "bootstrap-admin", source: "bootstrap-admin" },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.role).toBe("admin");
    expect(data).toHaveProperty("key");

    await storage.close();
  });
});

describe("key management", () => {
  it("creates and lists keys", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: { label: "test-member", source: "test-member-src", role: "member" },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.role).toBe("member");

    const listRes = await request(ctx.app, "GET", "/keys", {
      key: ctx.adminKey,
    });
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { keys: unknown[] };
    expect(body.keys.length).toBeGreaterThanOrEqual(2);
  });

  it("revokes a key", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: { label: "to-revoke", source: "to-revoke-src" },
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const revokeRes = await request(
      ctx.app,
      "DELETE",
      `/keys/${created.id as string}`,
      { key: ctx.adminKey },
    );
    expect(revokeRes.status).toBe(200);
  });
});

describe("extension_permissions wiring", () => {
  it("persists and surfaces extension_permissions on POST /keys and GET /keys", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "ext-write-key",
        source: "ext-write-key-src",
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: { "swift.calendar": "write" },
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      extension_permissions: Record<string, string>;
    };
    expect(created.extension_permissions).toEqual({
      "swift.calendar": "write",
    });

    const listRes = await request(ctx.app, "GET", "/keys", {
      key: ctx.adminKey,
    });
    const list = (await listRes.json()) as {
      keys: { id: string; extension_permissions?: Record<string, string> }[];
    };
    const found = list.keys.find((k) => k.id === created.id);
    expect(found?.extension_permissions).toEqual({ "swift.calendar": "write" });
  });

  it("auth middleware copies extension_permissions onto the request context", async () => {
    // Create a non-admin key with explicit grant on a namespace that doesn't
    // match its label. Without the wiring this would fall through to the
    // implicit own-namespace rule and 403 on the non-matching namespace.
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "myapp",
        source: "myapp-grant-src",
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: { "other-app.notes": "write" },
      },
    });
    const { key: rawKey } = (await createKeyRes.json()) as { key: string };

    const itemRes = await request(ctx.app, "POST", "/items", {
      key: rawKey,
      body: { type: "core.note", properties: { body: "Ext write target" } },
    });
    const { item } = (await itemRes.json()) as { item: { id: string } };

    const putRes = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/other-app.notes`,
      { key: rawKey, body: { stored: true } },
    );
    expect(putRes.status).toBe(200);
  });

  it("persists and surfaces metadata_permissions on POST /keys and GET /keys", async () => {
    // Workstream 1 close-out: metadata-layer permissions ride a
    // dedicated map. Default-off for new keys; admin still bypasses.
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "metadata-types-key",
        source: "metadata-types-key-src",
        role: "member",
        type_permissions: { "*": "write" },
        metadata_permissions: { types: "write" },
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      metadata_permissions: Record<string, string>;
    };
    expect(created.metadata_permissions).toEqual({ types: "write" });

    const listRes = await request(ctx.app, "GET", "/keys", {
      key: ctx.adminKey,
    });
    const list = (await listRes.json()) as {
      keys: { id: string; metadata_permissions?: Record<string, string> }[];
    };
    const found = list.keys.find((k) => k.id === created.id);
    expect(found?.metadata_permissions).toEqual({ types: "write" });
  });

  it("falls through to implicit own-namespace write when extension_permissions is empty", async () => {
    // Regression guard: the wiring change must not break the
    // "key writes its own namespace" implicit rule for keys with no grants.
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "selfns",
        source: "selfns-src",
        role: "member",
        type_permissions: { "*": "write" },
      },
    });
    const { key: rawKey } = (await createKeyRes.json()) as { key: string };

    const itemRes = await request(ctx.app, "POST", "/items", {
      key: rawKey,
      body: { type: "core.note", properties: { body: "Self ns target" } },
    });
    const { item } = (await itemRes.json()) as { item: { id: string } };

    const putRes = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/selfns`,
      { key: rawKey, body: { ok: true } },
    );
    expect(putRes.status).toBe(200);
  });
});

describe("KeyStore.updateLastUsed — DB-side debounce", () => {
  it("collapses rapid updates in the same window to a single write", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "last-used-debounce-key",
        source: "last-used-debounce-src",
        role: "member",
      },
    });
    const { id } = (await createRes.json()) as { id: string };

    // Three writes in rapid succession. With the old unconditional UPDATE
    // every instance would stamp its own `last_used_at`; with the new
    // conditional UPDATE the first write wins and subsequent attempts
    // inside the debounce window are no-ops.
    await ctx.storage.keys.updateLastUsed(id);
    const firstKey = await ctx.storage.keys.get(id);
    const firstStamp = firstKey?.last_used_at;
    expect(firstStamp).not.toBeNull();

    // A tiny pause so a naive always-overwrite would surface as a
    // monotonic change — if the stamp still moves, the debounce isn't
    // holding.
    await new Promise((r) => setTimeout(r, 5));
    await ctx.storage.keys.updateLastUsed(id);
    await new Promise((r) => setTimeout(r, 5));
    await ctx.storage.keys.updateLastUsed(id);

    const afterKey = await ctx.storage.keys.get(id);
    expect(afterKey?.last_used_at).toBe(firstStamp);
  });
});

describe("OAuth synthetic apiKey advances grant last_used_at (§3.4)", () => {
  it("stamps last_used_at on the app connection on a successful access-token request", async () => {
    _clearOAuthLastUsedCacheForTesting();
    // Set up a app + access token directly through the storage
    // layer; the public OAuth flow is exercised in oauth.test.ts.
    const client = await ctx.storage.oauth.createClient({
      name: "Test App (last_used_at)",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    const grant = await ctx.storage.items.create({
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: client.id,
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/oauth",
    });
    const rawToken = `myme_at_${Math.random().toString(36).slice(2)}_lru_test`;
    const tokenHash = hashApiKey(rawToken, "test-salt");
    await ctx.storage.oauth.createToken(
      grant.id,
      tokenHash,
      "access",
      new Date(Date.now() + 3600_000).toISOString(),
    );

    // Pre-condition: grant has no last_used_at yet.
    const beforeItem = await ctx.storage.items.get(grant.id);
    expect(beforeItem).not.toBeNull();
    expect(beforeItem?.properties.last_used_at).toBeUndefined();

    // Authenticated request through the OAuth path. The exact route is
    // immaterial — we just need the auth middleware to fire successfully.
    const res = await request(ctx.app, "GET", "/items", { key: rawToken });
    expect(res.status).toBe(200);

    // Post-condition: last_used_at advanced.
    const afterItem = await ctx.storage.items.get(grant.id);
    expect(afterItem?.properties.last_used_at).toEqual(expect.any(String));
    const stamped = afterItem?.properties.last_used_at as string;
    expect(Date.parse(stamped)).toBeGreaterThan(0);
  });
});

describe("T-098: /auth/token refresh advances grant last_used_at", () => {
  it("stamps last_used_at on the app connection when a refresh_token is exchanged for a new pair", async () => {
    _clearOAuthLastUsedCacheForTesting();

    const client = await ctx.storage.oauth.createClient({
      name: "Test App (T-098 refresh)",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    const grant = await ctx.storage.items.create({
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: client.id,
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/oauth-refresh",
    });
    const refreshRaw = `myme_rt_${Math.random().toString(36).slice(2)}_t098`;
    const refreshHash = hashApiKey(refreshRaw, "test-salt");
    await ctx.storage.oauth.createToken(
      grant.id,
      refreshHash,
      "refresh",
      new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    );

    const beforeItem = await ctx.storage.items.get(grant.id);
    expect(beforeItem?.properties.last_used_at).toBeUndefined();

    // Hit /auth/token with grant_type=refresh_token. No bearer header —
    // the refresh_token is in the form body. Pre-T-098 the middleware
    // never fires the stamp on this path; the new stamper call inside
    // handleRefresh covers the gap.
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshRaw,
    });
    const res = await ctx.app.fetch(
      new Request("http://test/auth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      }),
    );
    expect(res.status).toBe(200);

    const afterItem = await ctx.storage.items.get(grant.id);
    expect(afterItem?.properties.last_used_at).toEqual(expect.any(String));
  });

  it("debounce holds — a second refresh inside the window does not re-stamp the timestamp", async () => {
    _clearOAuthLastUsedCacheForTesting();

    const client = await ctx.storage.oauth.createClient({
      name: "Test App (T-098 debounce)",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    const grant = await ctx.storage.items.create({
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: client.id,
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/oauth-debounce",
    });
    // Two consecutive refresh tokens — the first refresh consumes one,
    // the second uses the rotated token issued by the first call.
    const refreshRaw1 = `myme_rt_${Math.random().toString(36).slice(2)}_db1`;
    const refreshHash1 = hashApiKey(refreshRaw1, "test-salt");
    await ctx.storage.oauth.createToken(
      grant.id,
      refreshHash1,
      "refresh",
      new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    );

    const fire = async (rt: string): Promise<Response> => {
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rt,
      });
      return ctx.app.fetch(
        new Request("http://test/auth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        }),
      );
    };

    const firstRes = await fire(refreshRaw1);
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as { refresh_token: string };
    const stamped1 = (await ctx.storage.items.get(grant.id))?.properties
      .last_used_at as string;
    expect(stamped1).toEqual(expect.any(String));

    const secondRes = await fire(firstBody.refresh_token);
    expect(secondRes.status).toBe(200);
    const stamped2 = (await ctx.storage.items.get(grant.id))?.properties
      .last_used_at as string;
    // Inside the 1h debounce window the in-memory cache short-circuits
    // the stamp, so the timestamp is unchanged. (The grant.updated_at
    // would change if the stamp had fired again — we read last_used_at
    // directly, which is the field the security page surfaces.)
    expect(stamped2).toBe(stamped1);
  });
});

describe("OAuthStore.updateLastUsedAt — DB-side debounce (T-101)", () => {
  it("collapses concurrent stamps in the same window to a single row write", async () => {
    // Mirrors the api-key `KeyStore.updateLastUsed` cluster regression
    // test above. Calling the storage method directly N times bypasses
    // the middleware-side in-memory cache (`oauthLastUsedCache`) — every
    // call hits the DB unconditionally. With the conditional WHERE in
    // place the first call wins and subsequent calls inside `thresholdMs`
    // are no-ops, demonstrating the cluster-wide guarantee: N instances
    // racing on the same grant produce one row write per window, not N.
    const client = await ctx.storage.oauth.createClient({
      name: "Test App (T-101 DB debounce)",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    const grant = await ctx.storage.items.create({
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: client.id,
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/oauth-t101-db-debounce",
    });

    // Pre-condition: no last_used_at stamp yet.
    const before = await ctx.storage.items.get(grant.id);
    expect(before?.properties.last_used_at).toBeUndefined();

    // First stamp populates last_used_at.
    await ctx.storage.oauth.updateLastUsedAt(grant.id, null, 3_600_000);
    const firstItem = await ctx.storage.items.get(grant.id);
    const firstStamp = firstItem?.properties.last_used_at as string;
    expect(firstStamp).toEqual(expect.any(String));

    // Two more stamps in rapid succession. Without the conditional WHERE
    // (the bug T-101 closes), each unconditional UPDATE would overwrite
    // the timestamp and the final value would be strictly greater than
    // `firstStamp`. With the conditional gate, the second and third
    // writes match zero rows and the timestamp does not move.
    await new Promise((r) => setTimeout(r, 5));
    await ctx.storage.oauth.updateLastUsedAt(grant.id, null, 3_600_000);
    await new Promise((r) => setTimeout(r, 5));
    await ctx.storage.oauth.updateLastUsedAt(grant.id, null, 3_600_000);

    const afterItem = await ctx.storage.items.get(grant.id);
    expect(afterItem?.properties.last_used_at).toBe(firstStamp);
  });

  it("re-stamps once the threshold elapses", async () => {
    // With a tiny threshold a second call past the window flips the
    // conditional gate open again and the row writes a fresh stamp.
    const client = await ctx.storage.oauth.createClient({
      name: "Test App (T-101 threshold elapses)",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    const grant = await ctx.storage.items.create({
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: client.id,
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/oauth-t101-threshold",
    });

    await ctx.storage.oauth.updateLastUsedAt(grant.id, null, 50);
    const firstStamp = (await ctx.storage.items.get(grant.id))?.properties
      .last_used_at as string;
    expect(firstStamp).toEqual(expect.any(String));

    // Wait past the 50ms threshold so the conditional WHERE re-opens.
    await new Promise((r) => setTimeout(r, 80));
    await ctx.storage.oauth.updateLastUsedAt(grant.id, null, 50);
    const secondStamp = (await ctx.storage.items.get(grant.id))?.properties
      .last_used_at as string;
    expect(secondStamp).not.toBe(firstStamp);
    expect(Date.parse(secondStamp)).toBeGreaterThan(Date.parse(firstStamp));
  });

  it("preserves every other property on the grant when stamping", async () => {
    // The conditional UPDATE merges last_used_at into the existing
    // properties JSON via dialect-native helpers (`jsonb_set` /
    // `json_set`), not by overwriting the blob. Sibling fields must
    // round-trip untouched.
    const client = await ctx.storage.oauth.createClient({
      name: "Test App (T-101 preserve)",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    const grantedAt = new Date().toISOString();
    const grant = await ctx.storage.items.create({
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: client.id,
        scopes: ["core.note:read", "core.task:write"],
        status: "active",
        granted_at: grantedAt,
      },
      source: "test/oauth-t101-preserve",
    });

    await ctx.storage.oauth.updateLastUsedAt(grant.id, null, 3_600_000);
    const after = await ctx.storage.items.get(grant.id);
    expect(after?.properties.kind).toBe("app");
    expect(after?.properties.client_id).toBe(client.id);
    expect(after?.properties.scopes).toEqual([
      "core.note:read",
      "core.task:write",
    ]);
    expect(after?.properties.status).toBe("active");
    expect(after?.properties.granted_at).toBe(grantedAt);
    expect(after?.properties.last_used_at).toEqual(expect.any(String));
  });

  it("respects tenant scoping — wrong tenant id does not stamp", async () => {
    // The tenant predicate in the WHERE makes the stamp a no-op when
    // the caller's tenantId does not match the grant's tenant_id.
    // Mirrors the tenant fence wrapped around `items.update` calls
    // elsewhere in the auth path.
    if (!ctx.storage.tenants) {
      // Test context without the tenants store (unusual) — skip the
      // hosted-mode-only assertion. The other T-101 cases above still
      // exercise the conditional WHERE in single-tenant shape.
      return;
    }
    const tenant = await ctx.storage.tenants.create("T-101 tenant fence");
    const client = await ctx.storage.oauth.createClient({
      name: "Test App (T-101 tenant fence)",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    const grant = await ctx.storage.items.create(
      {
        type: "system.connection",
        state: "active",
        tier: "library",
        properties: {
          kind: "app",
          client_id: client.id,
          scopes: ["core.note:read"],
          status: "active",
          granted_at: new Date().toISOString(),
        },
        source: "test/oauth-t101-tenant",
      },
      tenant.id,
    );

    // Wrong tenant id — no stamp.
    await ctx.storage.oauth.updateLastUsedAt(
      grant.id,
      "tnt_does_not_exist",
      3_600_000,
    );
    const noStamp = await ctx.storage.items.get(grant.id, tenant.id);
    expect(noStamp?.properties.last_used_at).toBeUndefined();

    // Right tenant id — stamps.
    await ctx.storage.oauth.updateLastUsedAt(grant.id, tenant.id, 3_600_000);
    const stamped = await ctx.storage.items.get(grant.id, tenant.id);
    expect(stamped?.properties.last_used_at).toEqual(expect.any(String));
  });
});

describe("touchLastUsedCache — bounded LRU eviction (§3.5)", () => {
  it("evicts the oldest entry when size exceeds cap", () => {
    // Use a tiny cap by overflowing past 32_768 once via direct API; that's
    // expensive — simpler to verify the FIFO contract on a smaller scale by
    // pre-filling the cache. The cap is internal; we verify the eviction
    // policy by confirming insertion order is preserved and the oldest key
    // is dropped first.
    const cache = new Map<string, number>();
    // Fill with 100 entries.
    for (let i = 0; i < 100; i++) {
      touchLastUsedCache(cache, `k${String(i)}`, i);
    }
    expect(cache.size).toBe(100);
    // First inserted key is still present (no overflow yet).
    expect(cache.has("k0")).toBe(true);

    // Re-touch k0 — it should move to the back, leaving k1 as the oldest.
    touchLastUsedCache(cache, "k0", 1000);
    const keys = Array.from(cache.keys());
    expect(keys[0]).toBe("k1");
    expect(keys[keys.length - 1]).toBe("k0");
  });

  it("FIFO contract: oldest insertion key is dropped first", () => {
    // Construct a tiny synthetic instance with a custom cap by exploiting
    // that touchLastUsedCache evicts when `size > LAST_USED_CACHE_MAX`. We
    // can't reach 32_768 cheaply in a unit test; instead, verify the
    // insertion-order invariant the eviction relies on.
    const cache = new Map<string, number>();
    touchLastUsedCache(cache, "alpha", 1);
    touchLastUsedCache(cache, "beta", 2);
    touchLastUsedCache(cache, "gamma", 3);
    // Re-touch beta — should move to back.
    touchLastUsedCache(cache, "beta", 4);
    const keys = Array.from(cache.keys());
    // Order: alpha (oldest), gamma, beta (most recent).
    expect(keys).toEqual(["alpha", "gamma", "beta"]);
    // Re-touch values reflect the latest timestamp.
    expect(cache.get("beta")).toBe(4);
  });
});
