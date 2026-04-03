import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import type { Storage } from "./storage/interface.js";

async function main() {
  const config = loadConfig();

  let storage: Storage;
  if (config.storageDialect === "pg") {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_DIALECT=pg");
    }
    storage = await createPgStorage(config.databaseUrl, {
      versionSnapshotIntervalMs: config.versionSnapshotIntervalMs,
    });
  } else {
    storage = createSqliteStorage(config.sqlitePath, {
      versionSnapshotIntervalMs: config.versionSnapshotIntervalMs,
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
  const app = createApp(storage, blobBackend, config);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Myme server listening on port ${String(info.port)}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
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
  console.error("Failed to start server:", err);
  process.exit(1);
});
