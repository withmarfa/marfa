export { createApp } from "./app.js";
export { loadConfig } from "./config.js";
export type { AppConfig } from "./config.js";
export type { Storage } from "./storage/interface.js";
export { createSqliteStorage } from "./storage/sqlite/index.js";
export { createBlobLayer } from "./storage/blob-layer.js";
export type { BlobLayer } from "./storage/blob-layer.js";
export { DiskBlobStore } from "./storage/blob-store.js";
export { S3BlobStore } from "./storage/blob-s3.js";
export type { BlobStore } from "./storage/blob-store.js";
export type { S3BlobConfig } from "./storage/blob-s3.js";
export { Housekeeping } from "./housekeeping/scheduler.js";
export type { HousekeepingJob } from "./housekeeping/scheduler.js";
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
export { initEventLog, __resetEventLogForTests } from "./pubsub.js";
// Exposed for the same reason as the two above. `createApp` does not print
// the bootstrap secret — the server's own boot does — so an app built from
// `createApp` alone has an unbootstrapped instance with no secret on it and
// no way for a harness to present one. Ensuring it is what boot does, and a
// harness that drives the first mint has to do the same or it is testing a
// door the product no longer has.
export { ensureBootstrapSecret } from "./auth/bootstrap-secret.js";
// And the identity, for the same reason again: `createApp` takes the name the
// instance answers to rather than reading it, so a harness that builds an app
// without the server's own boot has to resolve it the way boot does.
export { ensureInstanceId } from "./storage/instance-id.js";
