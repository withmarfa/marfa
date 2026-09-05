export { createApp } from "./app.js";
export { loadConfig } from "./config.js";
export type { AppConfig } from "./config.js";
export type { Storage } from "./storage/interface.js";
export { createSqliteStorage } from "./storage/sqlite/index.js";
export { createPgStorage } from "./storage/pg/index.js";
export { FilesystemBlobBackend } from "./storage/blob-backend.js";
export { S3BlobBackend } from "./storage/blob-s3.js";
export type { BlobBackend } from "./storage/blob-backend.js";
export type { S3BlobConfig } from "./storage/blob-s3.js";
// Exposed so test harnesses (and downstream consumers that want
// explicit worker control) can drive the bulk_action job loop on
// demand without rebuilding it.
export {
  BulkActionWorker,
  BulkActionJobGcSweeper,
  type BulkActionWorkerOptions,
} from "./bulk-actions/index.js";
// Exposed for the same reason as the worker above. `createApp` does not
// wire the event log — the server's own bootstrap does — so an app built
// from `createApp` alone assigns no event ids, replays nothing from a
// `Last-Event-ID`, and can never refuse a cursor as too old. A harness
// that needs any of those turns the log on itself, and resets it
// afterwards: the wiring is module-global, so it outlives the app it was
// turned on for.
export { initEventLog, __resetCycleDetectionForTests } from "./pubsub.js";
