import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import type { Storage } from "./storage/interface.js";
import { WebhookConsumer, WebhookPoller } from "./webhooks/delivery.js";
import { VersionThinner } from "./storage/version-thinner.js";
import { TrashPurger, FeedExpirer } from "./storage/retention.js";
import { initEventLog } from "./pubsub.js";
import { log } from "./middleware/logger.js";

async function main() {
  const config = loadConfig();

  // Log version info at startup
  try {
    const versionPath = resolve(process.cwd(), "version.json");
    const raw = await readFile(versionPath, "utf-8");
    const version = JSON.parse(raw) as Record<string, unknown>;
    log("info", "Server version", {
      sha: version.sha,
      deployed_at: version.deployed_at,
    });
  } catch {
    log("info", "Server version", { sha: "dev" });
  }

  let storage: Storage;
  if (config.storageDialect === "pg") {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_DIALECT=pg");
    }
    storage = await createPgStorage(config.databaseUrl, {
      versionSnapshotIntervalMs: config.versionSnapshotIntervalMs,
      authMode: config.authMode,
    });
  } else {
    storage = createSqliteStorage(config.sqlitePath, {
      versionSnapshotIntervalMs: config.versionSnapshotIntervalMs,
      authMode: config.authMode,
    });
  }

  let blobBackend: BlobBackend;
  if (config.blobBackend === "s3") {
    const { S3BlobBackend } = await import("./storage/blob-s3.js");
    blobBackend = new S3BlobBackend({
      bucket: config.s3Bucket,
      region: config.s3Region,
      endpoint: config.s3Endpoint || undefined,
      accessKeyId: config.s3AccessKeyId || undefined,
      secretAccessKey: config.s3SecretAccessKey || undefined,
    });
  } else {
    blobBackend = new FilesystemBlobBackend(config.blobPath);
  }
  // Enable SSE event persistence
  initEventLog(storage.eventLog);

  // Event log retention — clean up events older than the configured
  // window (default 168h / 7d; override via MYME_EVENT_LOG_RETENTION_HOURS).
  // Advisory-locked so multi-instance deployments run the sweep once per
  // tick cluster-wide.
  const eventLogRetentionHours = config.eventLogRetentionHours ?? 168;
  const runEventLogCleanup = () => {
    void storage.coordination
      .withJobLock("event-log-cleanup", () =>
        storage.eventLog.cleanup(eventLogRetentionHours),
      )
      .then((deleted) => {
        if (deleted !== undefined && deleted > 0)
          log(
            "info",
            `Purged ${String(deleted)} event_log entries older than ${String(eventLogRetentionHours)} hours`,
          );
      });
  };
  const eventLogCleanupDelay = setTimeout(runEventLogCleanup, 10_000);
  const eventLogCleanupInterval = setInterval(runEventLogCleanup, 3_600_000);

  // Audit retention — run once after startup, then on a daily schedule
  const runAuditCleanup = () => {
    void storage.coordination
      .withJobLock("audit-cleanup", () =>
        storage.audit.cleanup(config.auditRetentionDays),
      )
      .then((deleted) => {
        if (deleted !== undefined && deleted > 0)
          log(
            "info",
            `Purged ${String(deleted)} audit entries older than ${String(config.auditRetentionDays)} days`,
          );
      });
  };
  const auditCleanupDelay = setTimeout(runAuditCleanup, 5_000);
  const auditCleanupInterval = setInterval(
    runAuditCleanup,
    config.auditCleanupIntervalMs,
  );

  const webhookConsumer = new WebhookConsumer(
    storage.outboundWebhooks,
    storage.outboundWebhookDeliveries,
  );
  webhookConsumer.start();

  const webhookPoller = new WebhookPoller(storage.outboundWebhookDeliveries);
  webhookPoller.start();

  const versionThinner = new VersionThinner(
    storage.versions,
    {
      recentDays: config.versionRecentDays,
      dailySnapshotDays: config.versionDailySnapshotDays,
      weeklySnapshotDays: config.versionWeeklySnapshotDays,
      maxVersions: config.versionMaxVersions,
    },
    config.versionThinningIntervalMs,
    storage.coordination,
  );
  versionThinner.start();

  const trashPurger = new TrashPurger(
    storage.items,
    config.trashRetentionDays,
    config.trashPurgeIntervalMs,
    undefined,
    storage.coordination,
  );
  trashPurger.start();

  const feedExpirer = new FeedExpirer(
    storage.items,
    config.feedRetentionDays,
    config.feedExpiryIntervalMs,
    undefined,
    storage.coordination,
  );
  feedExpirer.start();

  const app = createApp(storage, blobBackend, config);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log("info", `Myme server listening on port ${String(info.port)}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    log("info", "Shutting down...");
    webhookConsumer.stop();
    webhookPoller.stop();
    clearTimeout(eventLogCleanupDelay);
    clearInterval(eventLogCleanupInterval);
    clearTimeout(auditCleanupDelay);
    clearInterval(auditCleanupInterval);
    versionThinner.stop();
    trashPurger.stop();
    feedExpirer.stop();
    server.close(() => {
      storage
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  log("error", "Failed to start server", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
