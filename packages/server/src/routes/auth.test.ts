import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { createApp } from "../app.js";
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
    const storage = createSqliteStorage(join(freshTmpDir, "boot.db"));
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
      feedRetentionDays: 0,
      feedExpiryIntervalMs: 86_400_000,
      errorWebhookUrl: "",
      trustedProxyCidrs: [],
      authBaseUrl: "http://localhost:0",
      authAllowSignup: true,
      authSecret: "test-auth-secret",
      oidcProviders: [],
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
