/**
 * Build the published OpenAPI document, the spec committed at the repo root.
 *
 * `scripts/generate-openapi.ts` is a thin wrapper over `buildPublishedOpenAPISpec`
 * so the committed artifact and any test that checks it exercise the same code
 * path rather than two copies of the assembly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createBlobLayer } from "./storage/blob-layer.js";
import { Housekeeping } from "./housekeeping/scheduler.js";
import { createApp } from "./app.js";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
  SERVERS,
} from "./openapi-finalize.js";
import type { AppConfig } from "./config.js";

function specGenerationConfig(blobPath: string): AppConfig {
  return {
    port: 8600,
    sqlitePath: ":memory:",
    blobPath,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: true,
    apiKeySalt: "openapi-generation-salt-not-for-production",
    corsOrigins: [],
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
  // A disk store has to live somewhere to be attached; a scratch directory
  // that goes with the run keeps the generator's marker out of the tree.
  const blobPath = await mkdtemp(join(tmpdir(), "marfa-openapi-"));
  try {
    const config = specGenerationConfig(blobPath);
    const app = createApp(
      storage,
      await createBlobLayer(storage, config),
      new Housekeeping(storage.housekeeping, { pollIntervalMs: 1_000 }),
      config,
      // A literal, not a mint. The document describes the shape of a
      // response, not this run's value, and an id in it would change the
      // generated file on every regeneration — which is exactly what the
      // freshness job reads as drift.
      SPEC_GENERATION_INSTANCE_ID,
    );
    // The committed document names a server; the one an instance serves at
    // `/openapi.json` does not, so tools resolve it against that instance.
    return {
      ...finalizeOpenAPISpec(
        app.getOpenAPI31Document({
          openapi: "3.1.0",
          info: OPENAPI_DOCUMENT_INFO,
        }),
      ),
      servers: SERVERS,
    };
  } finally {
    await storage.close();
    await rm(blobPath, { recursive: true, force: true });
  }
}
