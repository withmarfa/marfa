import { runAuditedTransaction } from "../storage/audited-transaction.js";
import {
  ErrorCode,
  generateId,
  hasPermission,
  MarfaError,
  resolveEnforcement,
} from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import { checkTypeAccess, mayReadType } from "../middleware/auth.js";
import type {
  BulkActionJobLease,
  BulkActionJobRow,
  BulkActionJobStore,
  Storage,
} from "../storage/interface.js";
import { runChunk, type ChunkOutcome } from "./runner.js";
import { resolveLiveCredential } from "../auth/live-credential.js";
import { yieldBulkWork } from "./yield.js";
import { sourceHiddenItemIds } from "./source-visibility.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { BulkActionErrorEntry, BulkActionInput } from "./types.js";

import { BulkActionLeaseLost, jobLease, ownsJob } from "./checkpoint.js";
import {
  originalErrorMessage,
  reconcileCommitHooks,
} from "../storage/sqlite/transaction-control.js";
import { errorMessage } from "../error-text.js";

const DEFAULT_CHUNK_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_POLL_BACKOFF_MULTIPLIER = 2;
const DEFAULT_STALE_AFTER_MS = 60_000;

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
   *  at a recovery check. Default 60s. */
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
  /** Settles when the run in flight has ended; already settled when none is. */
  private finishing: Promise<void> = Promise.resolve();
  /** Current idle backoff delay. Starts at `pollIntervalMs`, widens by
   *  `pollBackoffMultiplier` on each empty poll up to `maxPollIntervalMs`,
   *  and resets to `pollIntervalMs` whenever a job is claimed. */
  private currentPollMs: number;
  private lastRecoveryAt = Number.NEGATIVE_INFINITY;

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

  async start(): Promise<void> {
    this.stopped = false;
    await this.tryRecoverStale();
    this.scheduleNext(0);
  }

  /** Graceful shutdown. No new jobs are claimed after this, and the answer
   *  settles once the run in flight has finished. The caller bounds the
   *  wait: a run that outlives it loses its storage client when the caller
   *  closes it, and its job is recovered at the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.finishing;
  }

  /** Reset `in_progress` jobs with stale heartbeats back to `queued`.
   *  Called throughout the worker loop; exposed so tests can drive directly. */
  async recoverStale(): Promise<number> {
    const now = this.nowFn().getTime();
    // Failed sweeps share the cadence of successful ones; a failure must not
    // cause every subsequent chunk or idle poll to retry and log it again.
    this.lastRecoveryAt = now;
    const cutoff = new Date(now - this.staleAfterMs).toISOString();
    return this.jobs.recoverStale(cutoff);
  }

  /** Claim + run at most one job. Returns true if a job ran, false if
   *  the queue was empty. Tests drive this directly. */
  async runOnce(): Promise<boolean> {
    await this.maybeRecoverStale();
    const now = this.nowFn().toISOString();
    const job = await this.jobs.claimNext(this.workerId, now);
    if (!job) return false;
    try {
      await this.executeJob(job);
    } catch (err) {
      // executeJob handles its own errors; reaching here means something
      // outside the chunk loop went wrong (e.g. JSON parse of `input`).
      // Mark the job failed so it doesn't get stuck in_progress.
      const reason = originalErrorMessage(err);
      log("error", "bulk_action_worker.job_unhandled_error", {
        jobId: job.id,
        error: reason,
      });
      try {
        await this.jobs.failOwned(
          jobLease(job),
          reason,
          this.nowFn().toISOString(),
        );
      } catch (failure) {
        log("error", "bulk_action_worker.failure_state_uncertain", {
          jobId: job.id,
          error: originalErrorMessage(failure),
        });
      }
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
    let ended!: () => void;
    this.finishing = new Promise<void>((resolve) => {
      ended = resolve;
    });
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
        error: errorMessage(err),
      });
      this.scheduleNext(this.currentPollMs);
    } finally {
      this.inFlight = false;
      ended();
    }
  }

  private async maybeRecoverStale(): Promise<void> {
    const interval = Math.max(1, Math.min(this.staleAfterMs / 4, 10_000));
    if (this.nowFn().getTime() - this.lastRecoveryAt >= interval)
      await this.tryRecoverStale();
  }

  private async tryRecoverStale(): Promise<void> {
    // Recovery is auxiliary. The active chunk still obtains its writer turn
    // and checks its lease independently, even if this sweep cannot run.
    try {
      const recovered = await this.recoverStale();
      if (recovered > 0)
        log("info", "bulk_action_worker.recovered_stale_jobs", {
          recovered,
          workerId: this.workerId,
        });
    } catch (error) {
      log("warn", "bulk_action_worker.stale_recovery_failed", {
        workerId: this.workerId,
        error: originalErrorMessage(error),
      });
    }
  }

  private async readDurableState(
    lease: BulkActionJobLease,
  ): Promise<BulkActionJobRow | null> {
    // A new root transaction obtains a usable connection and a fresh snapshot
    // after the rejected transaction's cleanup, including uncertain commits.
    return this.storage.runInTransaction(() => this.jobs.getById(lease.jobId));
  }

  private isCommittedSlice(
    job: BulkActionJobRow | null,
    lease: BulkActionJobLease,
    toOffset: number,
  ): boolean {
    return (
      job !== null &&
      job.worker_id === lease.workerId &&
      job.claim_generation === lease.generation &&
      job.next_offset === toOffset &&
      (job.status === "in_progress" || job.status === "completed")
    );
  }

  private async executeJob(job: BulkActionJobRow): Promise<void> {
    const matchedIds = JSON.parse(job.matched_ids) as string[];
    const input = JSON.parse(job.input) as BulkActionInput;
    const lease = jobLease(job);
    let offset = job.next_offset;
    if (offset === matchedIds.length) {
      await this.jobs.completeOwned(lease, offset, this.nowFn().toISOString());
      return;
    }

    while (offset < matchedIds.length) {
      await this.maybeRecoverStale();
      const slice = matchedIds.slice(offset, offset + this.chunkSize);
      const toOffset = offset + slice.length;
      let permitted = slice;
      let refused: BulkActionErrorEntry[] = [];
      let committed: BulkActionJobRow | null;
      try {
        committed = await runAuditedTransaction(
          this.storage,
          async () => {
            const current = await this.jobs.beginChunk(
              lease,
              offset,
              this.nowFn().toISOString(),
            );
            if (!current) throw new BulkActionLeaseLost();
            // Resolving after the writer turn also observes credential mutations
            // queued ahead of this chunk, including enforcement overrides.
            const credential = await resolveLiveCredential(
              this.storage,
              job.api_key_id,
              { tokenOutlivesExpiry: true },
            );
            if (
              !credential ||
              (input.action === "purge" &&
                !hasPermission(credential.permissions, "items.purge"))
            ) {
              const reason = !credential
                ? "The credential that queued this job no longer authenticates, so the job wrote nothing further."
                : "The credential that queued this job no longer holds items.purge, so the job purged nothing further.";
              await this.jobs.failOwned(
                lease,
                reason,
                this.nowFn().toISOString(),
              );
              log("info", "bulk_action_worker.credential_withdrawn", {
                jobId: job.id,
                reason,
              });
              return null;
            }
            ({ permitted, refused } = await this.splitByWriteAccess(
              credential.key,
              slice,
            ));
            const carried = await this.jobs.carriedItems(job.id, slice);
            const outcome: ChunkOutcome =
              permitted.length > 0
                ? await runChunk({
                    storage: this.storage,
                    input,
                    ids: permitted,
                    carried,
                    credential,
                  })
                : { succeeded: [], errors: [] };
            return this.jobs.checkpointChunk(
              lease,
              offset,
              toOffset,
              {
                succeeded: outcome.succeeded,
                errors: [...refused, ...outcome.errors],
                carried: outcome.carried,
                blobHashes: outcome.blob_hashes,
              },
              this.nowFn().toISOString(),
            );
          },
          (checkpoint) =>
            checkpoint === null
              ? null
              : {
                  key_id: job.api_key_id ?? undefined,
                  action: "items.bulk_action.chunk",
                  resource_type: "items.bulk_action",
                  resource_id: job.id,
                  details: {
                    sub_action: input.action,
                    from_offset: offset,
                    to_offset: toOffset,
                    succeeded_total: checkpoint.succeeded_count,
                    errored_total: checkpoint.errored_count,
                  },
                },
          { retainCommitHooksOnUncertain: true },
        );
      } catch (error) {
        if (error instanceof BulkActionLeaseLost) return;
        let durable: BulkActionJobRow | null;
        try {
          durable = await this.readDurableState(lease);
        } catch (failure) {
          reconcileCommitHooks(error, "unknown");
          log("error", "bulk_action_worker.checkpoint_state_uncertain", {
            jobId: job.id,
            error: originalErrorMessage(error),
            reconciliation: originalErrorMessage(failure),
          });
          return;
        }
        if (this.isCommittedSlice(durable, lease, toOffset)) {
          reconcileCommitHooks(error, "committed");
          committed = durable;
        } else {
          const oldCursor = durable?.next_offset === offset;
          reconcileCommitHooks(error, oldCursor ? "rolled_back" : "unknown");
          if (!ownsJob(durable, lease) || durable.next_offset !== offset)
            return;
          const reason = originalErrorMessage(error);
          // The fresh writer snapshot at the old cursor proves that none of
          // the chunk committed. Its failure checkpoint must land before the
          // next slice is attempted, under the same owner and expected cursor.
          try {
            committed = await this.storage.runInTransaction(async () => {
              if (
                !(await this.jobs.beginChunk(
                  lease,
                  offset,
                  this.nowFn().toISOString(),
                ))
              )
                throw new BulkActionLeaseLost();
              return this.jobs.checkpointChunk(
                lease,
                offset,
                toOffset,
                {
                  succeeded: [],
                  errors: [
                    ...refused,
                    ...permitted.map((id) => ({
                      id,
                      code: "internal_error",
                      message: reason,
                    })),
                  ],
                },
                this.nowFn().toISOString(),
              );
            });
          } catch (failure) {
            if (failure instanceof BulkActionLeaseLost) return;
            try {
              const state = await this.readDurableState(lease);
              if (!this.isCommittedSlice(state, lease, toOffset)) return;
              committed = state;
            } catch (reconciliation) {
              log("error", "bulk_action_worker.failure_checkpoint_uncertain", {
                jobId: job.id,
                error: originalErrorMessage(failure),
                reconciliation: originalErrorMessage(reconciliation),
              });
              return;
            }
          }
        }
      }
      if (!committed) return;
      offset = committed.next_offset;
      if (offset < matchedIds.length) await yieldBulkWork();
    }
  }

  /**
   * Split a chunk into the rows the credential may still write and a
   * per-row refusal for the rest, asked of each row's type as the
   * single-item write doors ask it: a row whose type it may no longer read
   * is not found, without naming the type, and one it may read but not
   * write is `type_not_permitted`. A row no longer found goes through, so
   * the action reports it missing in its own words.
   */
  private async splitByWriteAccess(
    key: ApiKey,
    ids: string[],
  ): Promise<{ permitted: string[]; refused: BulkActionErrorEntry[] }> {
    const rows = await this.storage.items.getMany(ids, {
      includeTrashed: true,
    });
    const sourceFilter = resolveEnforcement(
      await readInstanceConfig(this.storage.settings),
      key,
    ).source_filter;
    const sourceHidden = await sourceHiddenItemIds(
      this.storage,
      rows,
      sourceFilter,
    );
    const permitted: string[] = [];
    const refused: BulkActionErrorEntry[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) {
        permitted.push(id);
        continue;
      }
      if (!mayReadType(key, row.type) || sourceHidden.has(id)) {
        refused.push({
          id,
          code: ErrorCode.ITEM_NOT_FOUND,
          message: "Item not found",
        });
        continue;
      }
      try {
        checkTypeAccess(key, row.type, "write");
        permitted.push(id);
      } catch (err) {
        if (!(err instanceof MarfaError)) throw err;
        refused.push({ id, code: err.code, message: err.message });
      }
    }
    return { permitted, refused };
  }
}
