/**
 * Build the published OpenAPI document — the spec committed at the repo root
 * and synced to the public API reference.
 *
 * `scripts/generate-openapi.ts` is a thin wrapper over `buildPublishedOpenAPISpec`
 * so the committed artifact and any test that checks it exercise the same code
 * path rather than two copies of the assembly.
 */

import { createSqliteStorage } from "./storage/sqlite/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import { createApp } from "./app.js";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "./openapi-finalize.js";
import type { AppConfig } from "./config.js";

const BLOB_PATH = "/tmp/marfa-openapi-blobs";

function specGenerationConfig(): AppConfig {
  return {
    port: 8600,
    sqlitePath: ":memory:",
    blobPath: BLOB_PATH,
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: true,
    apiKeySalt: "openapi-generation-salt-not-for-production",
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
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    trustedProxyHeader: null,
    authBaseUrl: "http://localhost:8600",
    authSecret: "openapi-generation-secret-not-for-production",
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
  };
}

/**
 * The identity the generator hands the app.
 *
 * Nothing in the published document carries it, so any string does; a fixed
 * one keeps the generation deterministic.
 */
const SPEC_GENERATION_INSTANCE_ID = "00000000-0000-7000-8000-000000000000";

/** Assemble the document published as the public API reference. */
export async function buildPublishedOpenAPISpec(): Promise<
  Record<string, unknown>
> {
  const storage = await createSqliteStorage(":memory:");
  try {
    const app = createApp(
      storage,
      new FilesystemBlobBackend(BLOB_PATH),
      specGenerationConfig(),
      // A literal, not a mint. The document describes the shape of a
      // response, not this run's value, and an id in it would change the
      // generated file on every regeneration — which is exactly what the
      // freshness job reads as drift.
      SPEC_GENERATION_INSTANCE_ID,
    );
    return finalizeOpenAPISpec(
      app.getOpenAPIDocument({
        openapi: "3.1.0",
        info: OPENAPI_DOCUMENT_INFO,
      }),
    ) as unknown as Record<string, unknown>;
  } finally {
    await storage.close();
  }
}
