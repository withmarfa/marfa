import { createApp } from "./app.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import { hashApiKey } from "./middleware/auth.js";
import type { Storage } from "./storage/interface.js";
import type { Hono } from "hono";
import type { AppEnv } from "./middleware/auth.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SALT = "test-salt";

export interface TestContext {
  app: Hono<AppEnv>;
  storage: Storage;
  blobBackend: BlobBackend;
  adminKey: string;
  cleanup: () => void;
}

async function truncatePg(storage: Storage): Promise<void> {
  const s = storage as unknown as Record<string, unknown>;
  if (typeof s._pgTruncate === "function") {
    await (s._pgTruncate as () => Promise<void>)();
  }
}

export async function createTestContext(): Promise<TestContext> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-test-"));
  const blobPath = join(tmpDir, "blobs");

  let storage: Storage;
  if (dialect === "pg") {
    const databaseUrl =
      process.env.DATABASE_URL ??
      "postgres://myme:myme_dev@localhost:5434/myme";
    storage = await createPgStorage(databaseUrl);
    await truncatePg(storage);
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = createSqliteStorage(dbPath);
  }

  const blobBackend = new FilesystemBlobBackend(blobPath);
  const app = createApp(storage, blobBackend, {
    port: 0,
    storageDialect: dialect as "sqlite" | "pg",
    sqlitePath: "",
    databaseUrl: "",
    blobPath,
    blobBackend: "fs",
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: SALT,
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

  // Create a bootstrap admin key (unique per test context to avoid PG conflicts)
  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = `myme_k1_test_admin_key_${suffix}`;
  const keyHash = hashApiKey(rawKey, SALT);
  await storage.keys.create(
    {
      label: "test-admin",
      source: `test-admin-${suffix}`,
      role: "admin",
      type_permissions: {},
      // V0 default: items created without an explicit `library` flag are
      // ambient (`library: false`). The test admin matches that — tests
      // that need library items pass `library: true` on create.
      default_library: false,
    },
    keyHash,
  );
  // Match what POST /keys would do on a real bootstrap call — stamp the
  // workspace sentinel so subsequent POST /keys calls in this context
  // require admin auth instead of re-entering bootstrap mode.
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    blobBackend,
    adminKey: rawKey,
    cleanup: () => {
      void storage.close();
    },
  };
}

export function request(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
    key?: string;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    ...options?.headers,
  };

  if (options?.key) {
    headers.Authorization = `Bearer ${options.key}`;
  }

  const init: RequestInit = { method, headers };
  if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  return Promise.resolve(app.request(path, init));
}
