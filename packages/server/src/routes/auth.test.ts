import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { ensureBootstrapSecret } from "../auth/bootstrap-secret.js";
import { createApp } from "../app.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("authentication", () => {
  it("returns 401 when no auth header is provided", async () => {
    const res = await request(ctx.app, "GET", "/items");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid key", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: "marfa_k1_invalid_key",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with a valid key", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
  });
});

describe("bootstrap mode", () => {
  it("mints the first key on the printed secret and no other credential", async () => {
    const freshTmpDir = mkdtempSync(join(tmpdir(), "marfa-boot-"));
    const storage = await createSqliteStorage(join(freshTmpDir, "boot.db"));
    const blobBackend = new FilesystemBlobBackend(join(freshTmpDir, "blobs"));
    const app = createApp(storage, blobBackend, {
      port: 0,
      sqlitePath: "",
      blobPath: "",
      blobBackend: "fs",
      maxBlobSize: 50 * 1024 * 1024,
      maxRequestBytes: 1_048_576,
      s3Bucket: "",
      s3Region: "us-east-1",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      apiKeySalt: "test-salt",
      corsOrigins: [],
      cdnBaseUrl: "",
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
      authSecret: "test-auth-secret",
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
    });

    // The one unauthenticated write in the product is bound to the host: the
    // first mint presents the one-time secret the server printed to its boot
    // log. This test builds the app directly and never runs that boot path,
    // so it obtains the secret the way boot does.
    const bootstrapSecret = await ensureBootstrapSecret(storage);
    const res = await request(app, "POST", "/keys", {
      key: bootstrapSecret,
      body: { label: "operator-key", source: "operator-key" },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    // The instance tier is a flag on the row rather than a rank,
    // so the seed credential is named by `is_operator`.
    expect(data.is_operator).toBe(true);
    expect(data).toHaveProperty("key");

    await storage.close();
    rmSync(freshTmpDir, { recursive: true, force: true });
  });
});

describe("key management", () => {
  it("creates and lists keys", async () => {
    // A narrower set than the caller's, because that is the half a mint can
    // get wrong: an omitted list takes the creator's whole set, so a response
    // that reported the wrong one would be indistinguishable from a response
    // that reported nothing.
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "test-narrow",
        source: "test-narrow-src",
        permissions: ["webhooks.manage"],
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      permissions?: string[];
    };
    expect(created.permissions).toEqual(["webhooks.manage"]);

    const listRes = await request(ctx.app, "GET", "/keys", {
      key: ctx.workingKey,
    });
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      keys: { id: string; permissions?: string[] }[];
    };
    expect(body.keys.length).toBeGreaterThanOrEqual(2);
    // The stored row says the same thing the mint response did. Asserted
    // separately because the two are built by different code, and the mint
    // response is the one a caller cannot go back and re-read.
    expect(body.keys.find((k) => k.id === created.id)?.permissions).toEqual([
      "webhooks.manage",
    ]);
  });

  it("revokes a key", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: { label: "to-revoke", source: "to-revoke-src" },
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const revokeRes = await request(
      ctx.app,
      "DELETE",
      `/keys/${created.id as string}`,
      { key: ctx.workingKey },
    );
    expect(revokeRes.status).toBe(200);
  });
});

describe("extension_permissions wiring", () => {
  it("persists and surfaces extension_permissions on POST /keys and GET /keys", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "ext-write-key",
        source: "ext-write-key-src",
        permissions: [],
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
      key: ctx.workingKey,
    });
    const list = (await listRes.json()) as {
      keys: { id: string; extension_permissions?: Record<string, string> }[];
    };
    const found = list.keys.find((k) => k.id === created.id);
    expect(found?.extension_permissions).toEqual({ "swift.calendar": "write" });
  });

  it("auth middleware copies extension_permissions onto the request context", async () => {
    // Create a key with an explicit grant on a namespace that doesn't match
    // its label. Without the wiring this would fall through to the implicit
    // own-namespace rule and 403 on the non-matching namespace.
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "myapp",
        source: "myapp-grant-src",
        permissions: [],
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
    // Metadata-layer permissions ride a dedicated map, default-off for new
    // keys. Nothing reads past it: every credential is held to its maps.
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "metadata-types-key",
        source: "metadata-types-key-src",
        permissions: [],
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
      key: ctx.workingKey,
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
      key: ctx.workingKey,
      body: {
        label: "selfns",
        source: "selfns-src",
        permissions: [],
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
      key: ctx.workingKey,
      body: {
        label: "last-used-debounce-key",
        source: "last-used-debounce-src",
        permissions: [],
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
