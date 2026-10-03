import {
  BulkActionLeaseLost,
  ownsJob,
  RESPONSE_SAMPLE_CAP,
  summarizeJob,
  type BulkActionSamples,
} from "../../bulk-actions/checkpoint.js";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type {
  BulkActionCheckpointDelta,
  BulkActionJobLease,
  BulkActionJobProgress,
  BulkActionJobRow,
  BulkActionJobStatus,
  BulkActionJobStore,
  CreateBulkActionJobInput,
} from "../interface.js";
import {
  bulkActionJobs,
  bulkActionJobCarriedItems,
  bulkActionJobPurgeHashes,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/** A job that has not reached a terminal state. Every write that ends a job
 *  is conditioned on it, so whichever of cancel, complete and fail lands
 *  first is final. */
const openJob = inArray(bulkActionJobs.status, [
  "queued",
  "in_progress",
] as BulkActionJobStatus[]);

/**
 * The SQLite implementation of `BulkActionJobStore`, over
 * `bulk_action_jobs`.
 *
 * A bounded UPDATE on the oldest queued row is what stops two worker loops
 * claiming the same job. The subquery is uncorrelated, so it runs once per
 * statement rather than per row, and SQLite takes one writer at a time:
 * the second loop's statement therefore begins after the first one's claim
 * committed, and its subquery picks the next queued row. The lone failure
 * mode — a process that crashes mid-execution — is covered by
 * `recoverStale` on boot.
 */
export class SqliteBulkActionJobStore implements BulkActionJobStore {
  constructor(private db: DrizzleDb) {}

  async create(input: CreateBulkActionJobInput): Promise<BulkActionJobRow> {
    const rows = await this.db
      .insert(bulkActionJobs)
      .values({
        id: input.id,
        api_key_id: input.api_key_id,
        credential: input.credential,
        status: "queued",
        action: input.action,
        input: input.input,
        matched_ids: input.matched_ids,
        matched_count: input.matched_count,
        created_at: input.created_at,
      })
      .returning()
      .all();
    const row = rows[0];
    if (!row) throw new Error("bulk_action_jobs INSERT returned no row");
    return rowToJob(row);
  }

  async getById(id: string): Promise<BulkActionJobRow | null> {
    const row = await this.db
      .select()
      .from(bulkActionJobs)
      .where(eq(bulkActionJobs.id, id))
      .get();
    return row ? rowToJob(row) : null;
  }

  async claimNext(
    workerId: string,
    now: string,
  ): Promise<BulkActionJobRow | null> {
    // Claim the oldest queued row. One UPDATE ... RETURNING under SQLite's
    // single writer, so two workers cannot claim the same row.
    const rows = await this.db
      .update(bulkActionJobs)
      .set({
        status: "in_progress",
        started_at: sql`coalesce(${bulkActionJobs.started_at}, ${now})`,
        claim_generation: sql`${bulkActionJobs.claim_generation} + 1`,
        worker_id: workerId,
        worker_heartbeat_at: now,
      })
      .where(
        eq(
          bulkActionJobs.id,
          sql`(SELECT id FROM bulk_action_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)`,
        ),
      )
      .returning()
      .all();
    const row = rows[0];
    return row ? rowToJob(row) : null;
  }

  private owned(lease: BulkActionJobLease, offset?: number) {
    return and(
      eq(bulkActionJobs.id, lease.jobId),
      eq(bulkActionJobs.status, "in_progress"),
      eq(bulkActionJobs.worker_id, lease.workerId),
      eq(bulkActionJobs.claim_generation, lease.generation),
      ...(offset === undefined ? [] : [eq(bulkActionJobs.next_offset, offset)]),
    );
  }

  async beginChunk(
    lease: BulkActionJobLease,
    expectedOffset: number,
    now: string,
  ): Promise<BulkActionJobRow | null> {
    const rows = await this.db
      .update(bulkActionJobs)
      .set({ worker_heartbeat_at: now })
      .where(this.owned(lease, expectedOffset))
      .returning()
      .all();
    const row = rows[0];
    return row ? rowToJob(row) : null;
  }

  async carriedItems(
    jobId: string,
    ids: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const result = new Set<string>();
    for (let start = 0; start < ids.length; start += 250) {
      const rows = await this.db
        .select({ item_id: bulkActionJobCarriedItems.item_id })
        .from(bulkActionJobCarriedItems)
        .where(
          and(
            eq(bulkActionJobCarriedItems.job_id, jobId),
            inArray(
              bulkActionJobCarriedItems.item_id,
              ids.slice(start, start + 250),
            ),
          ),
        )
        .all();
      for (const row of rows) result.add(row.item_id);
    }
    return result;
  }

  async checkpointChunk(
    lease: BulkActionJobLease,
    fromOffset: number,
    toOffset: number,
    delta: BulkActionCheckpointDelta,
    now: string,
  ): Promise<BulkActionJobRow> {
    return this.db.transaction(async () => {
      const current = await this.getById(lease.jobId);
      if (!ownsJob(current, lease) || current.next_offset !== fromOffset)
        throw new BulkActionLeaseLost();
      if (
        toOffset <= fromOffset ||
        toOffset > current.matched_count ||
        delta.succeeded.length + delta.errors.length > toOffset - fromOffset
      )
        throw new Error("Invalid bulk checkpoint delta");
      const carried = [...(delta.carried ?? [])];
      for (let start = 0; start < carried.length; start += 250) {
        await this.db
          .insert(bulkActionJobCarriedItems)
          .values(
            carried
              .slice(start, start + 250)
              .map((item_id) => ({ job_id: lease.jobId, item_id })),
          )
          .onConflictDoNothing()
          .run();
      }
      const hashes = [...(delta.blobHashes ?? [])];
      let newHashes = 0;
      for (let start = 0; start < hashes.length; start += 250) {
        const inserted = await this.db
          .insert(bulkActionJobPurgeHashes)
          .values(
            hashes
              .slice(start, start + 250)
              .map((hash) => ({ job_id: lease.jobId, hash })),
          )
          .onConflictDoNothing()
          .returning({ hash: bulkActionJobPurgeHashes.hash })
          .all();
        newHashes += inserted.length;
      }
      const samples = JSON.parse(current.checkpoint_json) as BulkActionSamples;
      const succeeded = current.succeeded_count + delta.succeeded.length;
      const checkpoint: BulkActionSamples = {
        ids:
          succeeded <= RESPONSE_SAMPLE_CAP
            ? [...samples.ids, ...delta.succeeded]
            : [],
        errors: [
          ...samples.errors,
          ...delta.errors.slice(0, RESPONSE_SAMPLE_CAP),
        ].slice(0, RESPONSE_SAMPLE_CAP),
      };
      const changes = {
        next_offset: toOffset,
        processed_count: current.processed_count + toOffset - fromOffset,
        succeeded_count: succeeded,
        errored_count: current.errored_count + delta.errors.length,
        blob_hashes_referenced_count:
          current.blob_hashes_referenced_count + newHashes,
        checkpoint_json: JSON.stringify(checkpoint),
        worker_heartbeat_at: now,
      };
      const finished = toOffset === current.matched_count;
      const rows = await this.db
        .update(bulkActionJobs)
        .set({
          ...changes,
          ...(finished
            ? {
                status: "completed",
                finished_at: now,
                worker_heartbeat_at: null,
                result: JSON.stringify(
                  summarizeJob({ ...current, ...changes }),
                ),
              }
            : {}),
        })
        .where(this.owned(lease, fromOffset))
        .returning()
        .all();
      if (!rows[0]) throw new BulkActionLeaseLost();
      return rowToJob(rows[0]);
    });
  }

  async completeOwned(
    lease: BulkActionJobLease,
    expectedOffset: number,
    now: string,
  ): Promise<boolean> {
    return this.db.transaction(async () => {
      const current = await this.getById(lease.jobId);
      if (
        !ownsJob(current, lease) ||
        current.next_offset !== expectedOffset ||
        expectedOffset !== current.matched_count
      )
        return false;
      const result = await this.db
        .update(bulkActionJobs)
        .set({
          status: "completed",
          result: JSON.stringify(summarizeJob(current)),
          finished_at: now,
          worker_heartbeat_at: null,
        })
        .where(this.owned(lease, expectedOffset))
        .run();
      return result.rowsAffected > 0;
    });
  }

  async failOwned(
    lease: BulkActionJobLease,
    error: string,
    now: string,
  ): Promise<boolean> {
    return this.db.transaction(async () => {
      const current = await this.getById(lease.jobId);
      if (!ownsJob(current, lease)) return false;
      const result = await this.db
        .update(bulkActionJobs)
        .set({
          status: "failed",
          error,
          result: JSON.stringify(summarizeJob(current)),
          finished_at: now,
          worker_heartbeat_at: null,
        })
        .where(this.owned(lease))
        .run();
      return result.rowsAffected > 0;
    });
  }

  async updateProgress(
    id: string,
    progress: BulkActionJobProgress,
    heartbeatAt: string,
  ): Promise<void> {
    await this.db
      .update(bulkActionJobs)
      .set({
        processed_count: progress.processed_count,
        succeeded_count: progress.succeeded_count,
        errored_count: progress.errored_count,
        worker_heartbeat_at: heartbeatAt,
      })
      .where(eq(bulkActionJobs.id, id))
      .run();
  }

  async complete(
    id: string,
    result: string,
    finalCounts: BulkActionJobProgress,
    finishedAt: string,
  ): Promise<void> {
    await this.db
      .update(bulkActionJobs)
      .set({
        status: "completed",
        result,
        processed_count: finalCounts.processed_count,
        succeeded_count: finalCounts.succeeded_count,
        errored_count: finalCounts.errored_count,
        finished_at: finishedAt,
        worker_heartbeat_at: null,
      })
      .where(and(eq(bulkActionJobs.id, id), openJob))
      .run();
  }

  async fail(
    id: string,
    error: string,
    finishedAt: string,
    sofar?: { result: string; counts: BulkActionJobProgress },
  ): Promise<void> {
    await this.db
      .update(bulkActionJobs)
      .set({
        status: "failed",
        error,
        ...(sofar ? { result: sofar.result, ...sofar.counts } : {}),
        finished_at: finishedAt,
        worker_heartbeat_at: null,
      })
      .where(and(eq(bulkActionJobs.id, id), openJob))
      .run();
  }

  async cancel(id: string, finishedAt: string): Promise<boolean> {
    const result = await this.db
      .update(bulkActionJobs)
      .set({
        status: "canceled",
        claim_generation: sql`${bulkActionJobs.claim_generation} + 1`,
        finished_at: finishedAt,
        worker_heartbeat_at: null,
      })
      .where(and(eq(bulkActionJobs.id, id), openJob))
      .run();
    return result.rowsAffected > 0;
  }

  async recoverStale(staleBeforeIso: string): Promise<number> {
    const result = await this.db
      .update(bulkActionJobs)
      .set({
        status: "queued",
        claim_generation: sql`${bulkActionJobs.claim_generation} + 1`,
        worker_id: null,
        worker_heartbeat_at: null,
      })
      .where(
        and(
          eq(bulkActionJobs.status, "in_progress"),
          isNotNull(bulkActionJobs.worker_heartbeat_at),
          lt(bulkActionJobs.worker_heartbeat_at, staleBeforeIso),
        ),
      )
      .run();
    return result.rowsAffected;
  }

  async gcExpired(expireBeforeIso: string): Promise<number> {
    const result = await this.db
      .delete(bulkActionJobs)
      .where(
        and(
          inArray(bulkActionJobs.status, [
            "completed",
            "failed",
            "canceled",
          ] as BulkActionJobStatus[]),
          isNotNull(bulkActionJobs.finished_at),
          lt(bulkActionJobs.finished_at, expireBeforeIso),
        ),
      )
      .run();
    return result.rowsAffected;
  }
}

function rowToJob(row: typeof bulkActionJobs.$inferSelect): BulkActionJobRow {
  return {
    id: row.id,
    api_key_id: row.api_key_id,
    credential: row.credential,
    status: row.status as BulkActionJobStatus,
    action: row.action,
    input: row.input,
    matched_ids: row.matched_ids,
    matched_count: row.matched_count,
    claim_generation: row.claim_generation,
    next_offset: row.next_offset,
    checkpoint_json: row.checkpoint_json,
    blob_hashes_referenced_count: row.blob_hashes_referenced_count,
    processed_count: row.processed_count,
    succeeded_count: row.succeeded_count,
    errored_count: row.errored_count,
    result: row.result,
    error: row.error,
    worker_id: row.worker_id,
    worker_heartbeat_at: row.worker_heartbeat_at,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}
