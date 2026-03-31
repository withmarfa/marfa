import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";

const config = loadConfig();
const storage = createSqliteStorage(config.sqlitePath);
const blobBackend = new FilesystemBlobBackend(config.blobPath);
const app = createApp(storage, blobBackend, config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Myme server listening on port ${String(info.port)}`);
});

export { createApp } from "./app.js";
export { loadConfig } from "./config.js";
export type { AppConfig } from "./config.js";
export type { Storage } from "./storage/interface.js";
export { createSqliteStorage } from "./storage/sqlite/index.js";
export { FilesystemBlobBackend } from "./storage/blob-backend.js";
