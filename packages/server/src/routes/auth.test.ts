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
      versionThinningIntervalMs: 3_600_000,
      versionRecentDays: 30,
      versionDailySnapshotDays: 90,
      versionWeeklySnapshotDays: 365,
      versionMaxVersions: 500,
      errorWebhookUrl: "",
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
