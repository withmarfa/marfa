/**
 * Generate the OpenAPI spec from route definitions.
 *
 * Usage: pnpm --filter @mymehq/server run generate:openapi
 *
 * Outputs the OpenAPI JSON to stdout. Redirect to a file:
 *   pnpm --filter @mymehq/server run generate:openapi > openapi.json
 */

import { createSqliteStorage } from "../src/storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../src/storage/blob-backend.js";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 8600,
  storageDialect: "sqlite",
  sqlitePath: ":memory:",
  databaseUrl: "",
  blobPath: "/tmp/myme-openapi-blobs",
  blobBackend: "fs",
  maxBlobSize: 50 * 1024 * 1024,
  s3Bucket: "",
  s3Region: "us-east-1",
  s3Endpoint: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  apiKeySalt: "openapi-generation-salt-not-for-production",
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
  ambientRetentionDays: 0,
  ambientExpiryIntervalMs: 86_400_000,
  errorWebhookUrl: "",
  electricUrl: "",
  idempotencyRetentionHours: 24,
  idempotencyCleanupIntervalMs: 3_600_000,
  trustedProxyCidrs: [],
};

const storage = createSqliteStorage(":memory:");
const blobBackend = new FilesystemBlobBackend("/tmp/myme-openapi-blobs");
const app = createApp(storage, blobBackend, config);

const spec = app.getOpenAPIDocument({
  openapi: "3.1.0",
  info: {
    title: "Myme API",
    version: "0.1.0",
    description: "Typed data layer for structured personal data",
  },
});

console.log(JSON.stringify(spec, null, 2));

await storage.close();
