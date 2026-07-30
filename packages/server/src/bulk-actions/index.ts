/**
 * Async substrate for `POST /items/bulk-actions`.
 *
 * Public surface:
 *   - `BulkActionWorker` — the in-process polling loop. One per server
 *     process; on PG `claimNext` uses `FOR UPDATE SKIP LOCKED` so
 *     multi-instance deployments coordinate naturally.
 *   - `BulkActionJobGcSweeper` — periodic retention sweep (default
 *     7 days, controlled by `BULK_ACTION_JOB_RETENTION_MS`).
 *   - `runChunk` — exposed for tests; the worker invokes it per chunk.
 *   - Wire types — `BulkActionInput`, `BulkActionResult`, `BulkActionJob`
 *     and their Zod schemas. The route handler in `routes/bulk.ts`
 *     reuses these so the schema is canonical at one place.
 */
export { BulkActionWorker, type BulkActionWorkerOptions } from "./worker.js";
export {
  setBulkJobEnqueueListener,
  notifyBulkJobEnqueued,
} from "./enqueue-signal.js";
export { BulkActionJobGcSweeper } from "./gc.js";
export { runChunk, type ChunkOutcome, type RunChunkContext } from "./runner.js";
export {
  BulkActionInputSchema,
  BulkActionResultSchema,
  BulkActionErrorEntrySchema,
  BulkActionJobSchema,
  BulkActionJobStatusSchema,
  type BulkActionInput,
  type BulkActionResult,
  type BulkActionErrorEntry,
  type BulkActionJob,
} from "./types.js";
