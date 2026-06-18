/**
 * Generate the OpenAPI spec from route definitions.
 *
 * Usage: pnpm --filter @withmarfa/server run generate:openapi
 *
 * Outputs the OpenAPI JSON to stdout. Redirect to a file:
 *   pnpm --filter @withmarfa/server run generate:openapi > openapi.json
 */

import { createSqliteStorage } from "../src/storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../src/storage/blob-backend.js";
import { createApp } from "../src/app.js";
import { finalizeOpenAPISpec } from "../src/openapi-finalize.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 8600,
  storageDialect: "sqlite",
  sqlitePath: ":memory:",
  databaseUrl: "",
  blobPath: "/tmp/marfa-openapi-blobs",
  blobBackend: "fs",
  maxBlobSize: 50 * 1024 * 1024,
  maxRequestBytes: 1_048_576,
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
  errorWebhookUrl: "",
  trustedProxyCidrs: [],
  authBaseUrl: "http://localhost:8600",
  authAllowSignup: false,
  seedStarterContent: false,
  authSecret: "openapi-generation-secret-not-for-production",
  oidcProviders: [],
  rateLimitDefaultLimit: 1000,
  rateLimitWindowMs: 60_000,
  oauthRedirectAllowlist: [],
};

const storage = await createSqliteStorage(":memory:");
const blobBackend = new FilesystemBlobBackend("/tmp/marfa-openapi-blobs");
const app = createApp(storage, blobBackend, config);

// `info.version` here is the API-contract version (the wire shape exposed
// at /openapi.json), distinct from the deployed-build `version` reported on
// `GET /`. Bumped to 5.1.0 in the docs API-surface rework: the path renames
// (bulk-actions, tenants/me/config, edge-types, lease-tokens) are breaking,
// but the API is pre-release and nothing pins the contract version yet, so the
// change deliberately rides a minor rather than a major. Keep in lockstep with
// the duplicate literal in `src/app.ts`.
const spec = finalizeOpenAPISpec(
  app.getOpenAPIDocument({
    openapi: "3.1.0",
    info: {
      title: "Marfa API",
      version: "5.1.0",
      description: "Typed data layer for structured personal data",
    },
  }),
);

console.log(JSON.stringify(spec, null, 2));

await storage.close();
