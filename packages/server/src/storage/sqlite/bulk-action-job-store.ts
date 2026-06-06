import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type {
  BulkActionJobProgress,
  BulkActionJobRow,
  BulkActionJobStatus,
  BulkActionJobStore,
  CreateBulkActionJobInput,
} from "../interface.js";
import { bulkActionJobs } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * SQLite implementation of the bulk_action job substrate.
 *
 * SQLite is single-process; there's no `FOR UPDATE SKIP LOCKED`. The
 * worker loop runs in-process inside one Node process, so a plain
 * subquery-bounded UPDATE on the oldest queued row is sufficient to
 * avoid double-claiming. The lone failure mode (process crashes
 * mid-execution) is covered by `recoverStale` on boot — same as PG.
 */
export class SqliteBulkActionJobStore implements BulkActionJobStore {
  constructor(private db: DrizzleDb) {}

  async create(input: CreateBulkActionJobInput): Promise<BulkActionJobRow> {
    if (input.idempotency_key) {
      // SQLite supports ON CONFLICT … DO UPDATE … RETURNING; on conflict
      // we set a no-op so RETURNING surfaces the existing row.
      const rows = await this.db
        .insert(bulkActionJobs)
        .values({
          id: input.id,
          tenant_id: input.tenant_id,
          api_key_id: input.api_key_id,
          status: "queued",
          action: input.action,
          input: input.input,
          matched_ids: input.matched_ids,
          matched_count: input.matched_count,
          idempotency_key: input.idempotency_key,
          created_at: input.created_at,
        })
        .onConflictDoUpdate({
          target: [bulkActionJobs.tenant_id, bulkActionJobs.idempotency_key],
          targetWhere: sql`idempotency_key IS NOT NULL`,
          set: { id: sql`bulk_action_jobs.id` },
        })
        .returning()
        .all();
      const row = rows[0];
      if (!row) throw new Error("bulk_action_jobs INSERT returned no row");
      return rowToJob(row);
    }

    const rows = await this.db
      .insert(bulkActionJobs)
      .values({
        id: input.id,
        tenant_id: input.tenant_id,
        api_key_id: input.api_key_id,
        status: "queued",
        action: input.action,
        input: input.input,
        matched_ids: input.matched_ids,
        matched_count: input.matched_count,
        idempotency_key: null,
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
    // Single-process: claim the oldest queued row. better-sqlite3 +
    // Drizzle execute synchronously inside this await, so no race
    // window across separate awaits.
    const rows = await this.db
      .update(bulkActionJobs)
      .set({
        status: "in_progress",
        started_at: now,
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
      .where(eq(bulkActionJobs.id, id))
      .run();
  }

  async fail(id: string, error: string, finishedAt: string): Promise<void> {
    await this.db
      .update(bulkActionJobs)
      .set({
        status: "failed",
        error,
        finished_at: finishedAt,
        worker_heartbeat_at: null,
      })
      .where(eq(bulkActionJobs.id, id))
      .run();
  }

  async cancel(id: string, finishedAt: string): Promise<boolean> {
    const result = await this.db
      .update(bulkActionJobs)
      .set({
        status: "cancelled",
        finished_at: finishedAt,
        worker_heartbeat_at: null,
      })
      .where(
        and(
          eq(bulkActionJobs.id, id),
          inArray(bulkActionJobs.status, [
            "queued",
            "in_progress",
          ] as BulkActionJobStatus[]),
        ),
      )
      .run();
    return result.rowsAffected > 0;
  }

  async recoverStale(staleBeforeIso: string): Promise<number> {
    const result = await this.db
      .update(bulkActionJobs)
      .set({
        status: "queued",
        worker_id: null,
        worker_heartbeat_at: null,
        started_at: null,
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
            "cancelled",
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
    tenant_id: row.tenant_id,
    api_key_id: row.api_key_id,
    status: row.status as BulkActionJobStatus,
    action: row.action,
    input: row.input,
    matched_ids: row.matched_ids,
    matched_count: row.matched_count,
    processed_count: row.processed_count,
    succeeded_count: row.succeeded_count,
    errored_count: row.errored_count,
    result: row.result,
    error: row.error,
    worker_id: row.worker_id,
    worker_heartbeat_at: row.worker_heartbeat_at,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}
