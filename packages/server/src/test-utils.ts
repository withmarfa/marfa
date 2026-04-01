import { createApp } from "./app.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
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
  blobBackend: FilesystemBlobBackend;
  adminKey: string;
  cleanup: () => void;
}

export async function createTestContext(): Promise<TestContext> {
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-test-"));
  const dbPath = join(tmpDir, "test.db");
  const blobPath = join(tmpDir, "blobs");

  const storage = createSqliteStorage(dbPath);
  const blobBackend = new FilesystemBlobBackend(blobPath);
  const app = createApp(storage, blobBackend, {
    port: 0,
    storageDialect: "sqlite",
    sqlitePath: dbPath,
    databaseUrl: "",
    blobPath,
    apiKeySalt: SALT,
    corsOrigins: [],
  });

  // Create a bootstrap admin key
  const rawKey = "myme_k1_test_admin_key_for_testing";
  const keyHash = hashApiKey(rawKey, SALT);
  await storage.keys.create(
    { label: "test-admin", role: "admin", type_permissions: {} },
    keyHash,
  );

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
