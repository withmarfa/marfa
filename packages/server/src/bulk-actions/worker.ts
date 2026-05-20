/**
 * T-218: in-process worker loop for the bulk_action job substrate.
 *
 * One loop per server process. PG: `claimNext` atomically picks a row
 * via `SELECT … FOR UPDATE SKIP LOCKED` so multiple processes pointed
 * at the same database coordinate naturally. SQLite: single-process, no
 * lock — the subquery-bounded UPDATE in `claimNext` is enough.
 *
 * Lifecycle: `start()` schedules a poll tick on an interval and runs
 * `runOnce()` immediately. `runOnce()` claims at most one job per call
 * and runs it through to a terminal state (cooperative cancellation
 * check between chunks). Tests drive `runOnce()` directly without
 * starting the timer.
 *
 * Restart recovery: on `start()`, jobs whose `worker_heartbeat_at` is
 * older than `staleAfterMs` are reset to `queued`. Default 60s.
 */
import { generateId } from "@mymehq/shared";
import { log } from "../middleware/logger.js";
import type {
  BulkActionJobRow,
  BulkActionJobStore,
  Storage,
} from "../storage/interface.js";
import { runChunk, type ChunkOutcome } from "./runner.js";
import type { BulkActionInput, BulkActionResult } from "./types.js";

const DEFAULT_CHUNK_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_STALE_AFTER_MS = 60_000;
/** Cap the `ids` array in the response envelope to match the existing
 *  `BulkActionResponse` shape (server emits ids only when small enough
 *  to be useful). Mirrors `routes/bulk.ts:860`. */
const RESPONSE_IDS_CAP = 100;

export interface BulkActionWorkerOptions {
  storage: Storage;
  /** Override the chunk size. Default 100. */
  chunkSize?: number;
  /** Poll cadence when the queue is empty. Default 500ms. */
  pollIntervalMs?: number;
  /** A job whose worker_heartbeat_at is older than this is recovered
   *  on boot. Default 60s. */
  staleAfterMs?: number;
  /** Identifier written to `worker_id`. Default randomly generated.
   *  Tests pass a fixed value for assertions. */
  workerId?: string;
  /** Override the `Date` source for tests. */
  nowFn?: () => Date;
}

export class BulkActionWorker {
  private readonly storage: Storage;
  private readonly jobs: BulkActionJobStore;
  private readonly chunkSize: number;
  private readonly pollIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly workerId: string;
  private readonly nowFn: () => Date;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Set when a run is in-flight; the next tick is queued behind it. */
  private inFlight = false;

  constructor(options: BulkActionWorkerOptions) {
    this.storage = options.storage;
    this.jobs = options.storage.bulkActionJobs;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.workerId = options.workerId ?? `bulk-action-worker-${generateId()}`;
    this.nowFn = options.nowFn ?? (() => new Date());
  }

  /** Start the periodic poll. Recovers stale jobs first, then schedules
   *  the first tick immediately. */
  async start(): Promise<void> {
    this.stopped = false;
    const recovered = await this.recoverStale();
    if (recovered > 0) {
      log("info", "bulk_action_worker.recovered_stale_jobs", {
        recovered,
        workerId: this.workerId,
      });
    }
    this.scheduleNext(0);
  }

  /** Graceful shutdown. The current in-flight run finishes; no new
   *  jobs are claimed after this. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Reset `in_progress` jobs with stale heartbeats back to `queued`.
   *  Called on `start()`; exposed so tests can drive directly. */
  async recoverStale(): Promise<number> {
    const cutoff = new Date(
      this.nowFn().getTime() - this.staleAfterMs,
    ).toISOString();
    return this.jobs.recoverStale(cutoff);
  }

  /** Claim + run at most one job. Returns true if a job ran, false if
   *  the queue was empty. Tests drive this directly. */
  async runOnce(): Promise<boolean> {
    const now = this.nowFn().toISOString();
    const job = await this.jobs.claimNext(this.workerId, now);
    if (!job) return false;
    try {
      await this.executeJob(job);
    } catch (err) {
      // executeJob handles its own errors; reaching here means something
      // outside the chunk loop went wrong (e.g. JSON parse of `input`).
      // Mark the job failed so it doesn't get stuck in_progress.
      const reason = err instanceof Error ? err.message : String(err);
      log("error", "bulk_action_worker.job_unhandled_error", {
        jobId: job.id,
        error: reason,
      });
      await this.jobs.fail(job.id, reason, this.nowFn().toISOString());
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      // A previous tick is still running. Re-arm and let it return
      // before claiming again.
      this.scheduleNext(this.pollIntervalMs);
      return;
    }
    this.inFlight = true;
    try {
      const ran = await this.runOnce();
      // If we ran a job, immediately try the next — there may be more
      // queued. Otherwise wait the full interval.
      this.scheduleNext(ran ? 0 : this.pollIntervalMs);
    } catch (err) {
      log("error", "bulk_action_worker.tick_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleNext(this.pollIntervalMs);
    } finally {
      this.inFlight = false;
    }
  }

  private async executeJob(job: BulkActionJobRow): Promise<void> {
    const matchedIds = JSON.parse(job.matched_ids) as string[];
    const input = JSON.parse(job.input) as BulkActionInput;

    const accSucceeded: string[] = [];
    const accErrors: { id: string; code: string; message: string }[] = [];
    const accBlobHashes = new Set<string>();
    let processed = 0;

    for (let i = 0; i < matchedIds.length; i += this.chunkSize) {
      // Cancellation check between chunks. Cheap (single SELECT by id)
      // and only adds at most chunkSize / matchedCount latency to a
      // cancel request observing.
      const current = await this.jobs.getById(job.id);
      if (!current || current.status === "cancelled") {
        // Cancelled mid-run. Don't overwrite the row's status — the
        // cancel route already set it. Just return.
        log("info", "bulk_action_worker.cancelled_mid_run", {
          jobId: job.id,
          processed,
          matched: matchedIds.length,
        });
        return;
      }

      const slice = matchedIds.slice(i, i + this.chunkSize);
      let outcome: ChunkOutcome;
      try {
        outcome = await runChunk({
          storage: this.storage,
          tenantId: job.tenant_id,
          input,
          ids: slice,
        });
      } catch (err) {
        // Whole-chunk failure inside the transaction (e.g. storage
        // dialect error). Annotate every id and continue to the next
        // chunk — best-effort semantics match the synchronous endpoint.
        const reason = err instanceof Error ? err.message : String(err);
        outcome = {
          succeeded: [],
          errors: slice.map((id) => ({
            id,
            code: "internal_error",
            message: reason,
          })),
        };
      }

      accSucceeded.push(...outcome.succeeded);
      accErrors.push(...outcome.errors);
      if (outcome.blob_hashes) {
        for (const h of outcome.blob_hashes) accBlobHashes.add(h);
      }
      processed += slice.length;

      await this.jobs.updateProgress(
        job.id,
        {
          processed_count: processed,
          succeeded_count: accSucceeded.length,
          errored_count: accErrors.length,
        },
        this.nowFn().toISOString(),
      );
    }

    const result: BulkActionResult = {
      action: input.action,
      matched: matchedIds.length,
      succeeded: accSucceeded.length,
      errored: accErrors.length,
      dry_run: false,
      ...(accSucceeded.length > 0 && accSucceeded.length <= RESPONSE_IDS_CAP
        ? { ids: accSucceeded }
        : {}),
      ...(accErrors.length > 0 ? { errors: accErrors } : {}),
      ...(input.action === "purge"
        ? { blob_hashes_referenced: accBlobHashes.size }
        : {}),
    };

    await this.jobs.complete(
      job.id,
      JSON.stringify(result),
      {
        processed_count: processed,
        succeeded_count: accSucceeded.length,
        errored_count: accErrors.length,
      },
      this.nowFn().toISOString(),
    );
  }
}
