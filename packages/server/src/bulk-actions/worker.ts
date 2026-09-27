/**
 * In-process worker loop over `bulk_action_jobs`.
 *
 * One loop per server process, and `claimNext`'s bounded UPDATE is what
 * stops two of them running the same job: each claim is one statement, so
 * the second loop's subquery runs after the first loop's claim committed
 * and picks the next queued row instead. It comes back empty only when the
 * queue is.
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
import { generateId } from "@withmarfa/shared";
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
const DEFAULT_MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_POLL_BACKOFF_MULTIPLIER = 2;
const DEFAULT_STALE_AFTER_MS = 60_000;
/** Cap the `ids` array in the response envelope to match the existing
 *  `BulkActionResponse` shape (server emits ids only when small enough
 *  to be useful). Mirrors `routes/bulk.ts:860`. */
const RESPONSE_IDS_CAP = 100;
/**
 * Cap the `errors` array for the same reason `ids` is capped, and the reason
 * is now sharper than symmetry.
 *
 * `errored` beside it is the true count, so nothing is lost by truncating the
 * list; what is lost by not truncating it is the job row. Until property
 * patches were judged per row, the only per-row error this action produced
 * was a version conflict, which needs a concurrent writer per row. A patch
 * the type refuses fails *every* matched row, so one mistyped call against a
 * fifty-thousand-row match set serialized fifty thousand entries into the
 * row and returned them whole on every terminal poll — and the kits poll
 * transparently, so a caller would not have asked for it.
 */
const RESPONSE_ERRORS_CAP = 100;

export interface BulkActionWorkerOptions {
  storage: Storage;
  /** Override the chunk size. Default 100. */
  chunkSize?: number;
  /** Base (and floor) poll cadence. Used immediately after a job runs and
   *  as the starting interval after an empty poll. Default 500ms. */
  pollIntervalMs?: number;
  /** Ceiling the idle backoff widens toward. Once the queue goes quiet the
   *  empty-poll interval grows by `pollBackoffMultiplier` each tick, capped
   *  here, so an idle worker stops hammering the DB every 500ms. A claimed
   *  job resets the interval back to `pollIntervalMs`. Default 60s. */
  maxPollIntervalMs?: number;
  /** Factor the empty-poll interval grows by each idle tick, between
   *  `pollIntervalMs` and `maxPollIntervalMs`. Default 2 (geometric). */
  pollBackoffMultiplier?: number;
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
  private readonly maxPollIntervalMs: number;
  private readonly pollBackoffMultiplier: number;
  private readonly staleAfterMs: number;
  private readonly workerId: string;
  private readonly nowFn: () => Date;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Set when a run is in-flight; the next tick is queued behind it. */
  private inFlight = false;
  /** Current idle backoff delay. Starts at `pollIntervalMs`, widens by
   *  `pollBackoffMultiplier` on each empty poll up to `maxPollIntervalMs`,
   *  and resets to `pollIntervalMs` whenever a job is claimed. */
  private currentPollMs: number;

  constructor(options: BulkActionWorkerOptions) {
    this.storage = options.storage;
    this.jobs = options.storage.bulkActionJobs;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollIntervalMs =
      options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    this.pollBackoffMultiplier =
      options.pollBackoffMultiplier ?? DEFAULT_POLL_BACKOFF_MULTIPLIER;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.workerId = options.workerId ?? `bulk-action-worker-${generateId()}`;
    this.nowFn = options.nowFn ?? (() => new Date());
    this.currentPollMs = this.pollIntervalMs;
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

  /**
   * Tell the worker a job was just enqueued.
   *
   * Without this the idle backoff is the whole latency. It widens
   * geometrically to a sixty-second ceiling while the queue is quiet, and
   * nothing shortened it, so a job arriving into a settled worker waited
   * out whatever interval happened to be pending. Measured on staging: a
   * job sat queued for about thirty-two seconds and then did sixty-five
   * milliseconds of work. Cold start was ruled out; the container was warm.
   *
   * Thirty seconds to pick up half a second of work is the kind of number
   * that becomes a support question rather than a bug report, because the
   * user triggers an action, sees nothing, and by the time they look again
   * it is done. Nobody files that.
   *
   * Idempotent and cheap: it resets the backoff and pulls the pending timer
   * forward to now. A burst of enqueues collapses into one immediate tick
   * rather than one per job, and a tick already in flight is left alone —
   * it will re-arm at the reset cadence when it finishes.
   */
  wake(): void {
    if (this.stopped) return;
    this.currentPollMs = this.pollIntervalMs;
    if (this.inFlight) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      // A previous tick is still running. Re-arm at the current cadence and
      // let it return before claiming again.
      this.scheduleNext(this.currentPollMs);
      return;
    }
    this.inFlight = true;
    try {
      const ran = await this.runOnce();
      if (ran) {
        // A job was claimed — reset the backoff and immediately try the
        // next; there may be more queued. Keep the hot path at zero delay.
        this.currentPollMs = this.pollIntervalMs;
        this.scheduleNext(0);
      } else {
        // Empty queue — widen the idle interval geometrically up to the
        // cap so a quiet worker stops polling the DB every pollIntervalMs.
        this.currentPollMs = Math.min(
          this.currentPollMs * this.pollBackoffMultiplier,
          this.maxPollIntervalMs,
        );
        this.scheduleNext(this.currentPollMs);
      }
    } catch (err) {
      log("error", "bulk_action_worker.tick_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleNext(this.currentPollMs);
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
    const broughtBack = new Set<string>();
    let processed = 0;

    for (let i = 0; i < matchedIds.length; i += this.chunkSize) {
      // Cancellation check between chunks. Cheap (single SELECT by id)
      // and only adds at most chunkSize / matchedCount latency to a
      // cancel request observing.
      const current = await this.jobs.getById(job.id);
      if (!current || current.status === "canceled") {
        // Canceled mid-run. Don't overwrite the row's status — the
        // cancel route already set it. Just return.
        log("info", "bulk_action_worker.canceled_mid_run", {
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
          input,
          ids: slice,
          broughtBack,
        });
      } catch (err) {
        // Whole-chunk failure inside the transaction — a database error,
        // say. Annotate every id and continue to the next
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
      // Truncated rather than omitted past the cap: a caller with one bad
      // patch wants to see what the refusal says, and one entry says it as
      // well as fifty thousand. `errored` carries the count either way.
      ...(accErrors.length > 0
        ? { errors: accErrors.slice(0, RESPONSE_ERRORS_CAP) }
        : {}),
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
