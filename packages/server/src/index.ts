import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { Storage } from "./storage/interface.js";

async function main() {
  const config = loadConfig();

  let storage: Storage;
  if (config.storageDialect === "pg") {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_DIALECT=pg");
    }
    storage = await createPgStorage(config.databaseUrl);
  } else {
    storage = createSqliteStorage(config.sqlitePath);
  }

  const blobBackend = new FilesystemBlobBackend(config.blobPath);
  const app = createApp(storage, blobBackend, config);

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Myme server listening on port ${String(info.port)}`);
  });
}

main().catch((err: unknown) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
