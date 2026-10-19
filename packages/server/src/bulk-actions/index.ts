/**
 * The job queue behind `POST /items/bulk-actions`.
 *
 * Public surface:
 *   - `BulkActionWorker` — the in-process polling loop. One per server
 *     process.
 *   - `BulkActionJobGcSweeper` — periodic retention sweep (default
 *     7 days, controlled by `BULK_ACTION_JOB_RETENTION_MS`).
 *   - `runChunk` — exposed for tests; the worker invokes it per chunk.
 */
export { BulkActionWorker } from "./worker.js";
export {
  setBulkJobEnqueueListener,
  notifyBulkJobEnqueued,
} from "./enqueue-signal.js";
export { BulkActionJobGcSweeper } from "./gc.js";
export { runChunk } from "./runner.js";
