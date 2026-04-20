import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

async function createKey(overrides: Record<string, unknown> = {}): Promise<{
  id: string;
  key: string;
  source: string;
}> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label: `subject-${suffix}`,
      source: `subject-${suffix}`,
      role: "member",
      default_origin: "user",
      default_library: false,
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      ...overrides,
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    id: string;
    key: string;
    source: string;
  };
  return body;
}

describe("PATCH /keys/{id}", () => {
  it("updates label, permissions, and defaults in place", async () => {
    const { id, source } = await createKey();

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.adminKey,
      body: {
        label: "renamed",
        default_origin: "ai",
        default_library: true,
        type_permissions: { "core.note": "write" },
        extension_permissions: { "my-app.prefs": "read" },
        edge_permissions: { "parent-of": "write" },
      },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.id).toBe(id);
    expect(updated.label).toBe("renamed");
    // source is immutable — it must not have changed
    expect(updated.source).toBe(source);
    expect(updated.role).toBe("member");
    expect(updated.default_origin).toBe("ai");
    expect(updated.default_library).toBe(true);
    expect(updated.type_permissions).toEqual({ "core.note": "write" });
    expect(updated.extension_permissions).toEqual({ "my-app.prefs": "read" });
    expect(updated.edge_permissions).toEqual({ "parent-of": "write" });
  });

  it("leaves untouched fields alone on a partial patch", async () => {
    const { id } = await createKey({
      label: "before",
      default_library: false,
      type_permissions: { "core.note": "read" },
    });

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.adminKey,
      body: { label: "after" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.label).toBe("after");
    expect(updated.default_library).toBe(false);
    expect(updated.type_permissions).toEqual({ "core.note": "read" });
  });

  it("returns 403 for a non-admin caller", async () => {
    const { id } = await createKey();
    const { key: memberKey } = await createKey({
      label: "patcher-member",
      type_permissions: { "*": "read" },
    });

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: memberKey,
      body: { label: "nope" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when attempting to change the immutable `source`", async () => {
    const { id } = await createKey();

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.adminKey,
      body: { source: "something-else" },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/source.*immutable/i);
  });

  it("returns 400 when attempting to change the immutable `role`", async () => {
    const { id } = await createKey();

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.adminKey,
      body: { role: "admin" },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/role.*immutable/i);
  });

  it("returns 404 for an unknown key id", async () => {
    // Valid UUIDv7 shape, guaranteed not to exist in the store.
    const ghostId = "00000000-0000-7000-8000-000000000000";
    const res = await request(ctx.app, "PATCH", `/keys/${ghostId}`, {
      key: ctx.adminKey,
      body: { label: "ghost" },
    });
    expect(res.status).toBe(404);
  });
});

describe("bootstrap sentinel", () => {
  // Builds a fresh SQLite-backed app with NO existing key and NO
  // sentinel set — mirrors a brand-new installation. Uses sqlite
  // directly (not createTestContext) so we can go through POST /keys
  // on a truly empty workspace.
  function freshApp() {
    const tmpDir = mkdtempSync(join(tmpdir(), "myme-bootstrap-"));
    const storage = createSqliteStorage(join(tmpDir, "test.db"));
    const blobBackend = new FilesystemBlobBackend(join(tmpDir, "blobs"));
    const app = createApp(storage, blobBackend, {
      port: 0,
      storageDialect: "sqlite",
      sqlitePath: "",
      databaseUrl: "",
      blobPath: join(tmpDir, "blobs"),
      blobBackend: "fs",
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
      trashPurgeIntervalMs: 3_600_000,
      ambientRetentionDays: 0,
      ambientExpiryIntervalMs: 3_600_000,
      errorWebhookUrl: "",
      trustedProxyCidrs: [],
    });
    return { app, storage };
  }

  it("admits the first unauthenticated POST /keys as bootstrap", async () => {
    const { app, storage } = freshApp();
    try {
      const res = await request(app, "POST", "/keys", {
        body: {
          label: "first-admin",
          source: "first-admin",
          role: "member",
          default_origin: "user",
          default_library: false,
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { role: string };
      // Bootstrap key is coerced to admin regardless of requested role.
      expect(body.role).toBe("admin");
      // Sentinel must now be stamped.
      const stamped = await storage.settings.get("bootstrapped");
      expect(stamped).toBe("true");
    } finally {
      await storage.close();
    }
  });

  it("does NOT re-open bootstrap after every key is revoked", async () => {
    const { app, storage } = freshApp();
    try {
      // First unauthenticated POST succeeds as bootstrap.
      const firstRes = await request(app, "POST", "/keys", {
        body: {
          label: "first-admin",
          source: "first-admin",
          role: "member",
          default_origin: "user",
          default_library: false,
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(firstRes.status).toBe(201);
      const { id: firstId } = (await firstRes.json()) as { id: string };

      // Revoke every key.
      await storage.keys.revoke(firstId);

      // Next unauthenticated POST must be rejected — this is the
      // regression the persistent sentinel prevents.
      const secondRes = await request(app, "POST", "/keys", {
        body: {
          label: "takeover",
          source: "takeover",
          role: "member",
          default_origin: "user",
          default_library: false,
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(secondRes.status).toBe(401);
    } finally {
      await storage.close();
    }
  });
});
