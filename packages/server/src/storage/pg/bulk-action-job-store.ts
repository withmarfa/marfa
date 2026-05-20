import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type {
  BulkActionJobProgress,
  BulkActionJobRow,
  BulkActionJobStatus,
  BulkActionJobStore,
  CreateBulkActionJobInput,
} from "../interface.js";
import { bulkActionJobs } from "./schema.js";
import type { PgDb } from "./connection.js";

/** T-218: PG implementation of the bulk_action job substrate.
 *
 * Single-process atomic claim uses `UPDATE … WHERE id IN (SELECT … FOR
 * UPDATE SKIP LOCKED LIMIT 1) RETURNING …` — same pattern as
 * `webhook-delivery-store.getPending`. Two server processes sharing the
 * database pick different jobs; the row-level lock dropped at commit
 * time means a process that picks a job and crashes mid-claim doesn't
 * leak the lock. The mid-execution recovery path is `recoverStale`
 * (called on boot) which resets `in_progress` rows with stale
 * heartbeats back to `queued`. */
export class PgBulkActionJobStore implements BulkActionJobStore {
  constructor(private db: PgDb) {}

  async create(input: CreateBulkActionJobInput): Promise<BulkActionJobRow> {
    // Idempotency path: when an idempotency_key is set, ON CONFLICT
    // returns the existing row. The partial-unique index guards the
    // (tenant_id, idempotency_key) pair when idempotency_key is not
    // null; rows without a key always insert fresh.
    if (input.idempotency_key) {
      const result = await this.db.execute(sql`
        INSERT INTO bulk_action_jobs (
          id, tenant_id, api_key_id, status, action,
          input, matched_ids, matched_count, idempotency_key, created_at
        ) VALUES (
          ${input.id}, ${input.tenant_id}, ${input.api_key_id}, 'queued', ${input.action},
          ${input.input}, ${input.matched_ids}, ${input.matched_count},
          ${input.idempotency_key}, ${input.created_at}
        )
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
        DO UPDATE SET id = bulk_action_jobs.id
        RETURNING *
      `);
      const rows = result as unknown as BulkActionJobRow[];
      const row = rows[0];
      if (!row) {
        throw new Error("bulk_action_jobs INSERT returned no row");
      }
      return row;
    }

    const [row] = await this.db
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
      .returning();
    if (!row) {
      throw new Error("bulk_action_jobs INSERT returned no row");
    }
    return rowToJob(row);
  }

  async getById(id: string): Promise<BulkActionJobRow | null> {
    const [row] = await this.db
      .select()
      .from(bulkActionJobs)
      .where(eq(bulkActionJobs.id, id));
    return row ? rowToJob(row) : null;
  }

  async claimNext(
    workerId: string,
    now: string,
  ): Promise<BulkActionJobRow | null> {
    // Single-statement atomic claim. Other processes' SELECT FOR UPDATE
    // SKIP LOCKED will skip the row this process locks.
    const result = await this.db.execute(sql`
      UPDATE bulk_action_jobs
      SET status = 'in_progress',
          started_at = ${now},
          worker_id = ${workerId},
          worker_heartbeat_at = ${now}
      WHERE id IN (
        SELECT id FROM bulk_action_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `);
    const rows = result as unknown as BulkActionJobRow[];
    return rows[0] ?? null;
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
      .where(eq(bulkActionJobs.id, id));
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
      .where(eq(bulkActionJobs.id, id));
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
      .where(eq(bulkActionJobs.id, id));
  }

  async cancel(id: string, finishedAt: string): Promise<boolean> {
    // CAS: only cancel if currently in a non-terminal state. Returns
    // true if we actually flipped the row (i.e. caller's request had
    // effect), false on already-terminal rows.
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
      .returning({ id: bulkActionJobs.id });
    return result.length > 0;
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
      .returning({ id: bulkActionJobs.id });
    return result.length;
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
      .returning({ id: bulkActionJobs.id });
    return result.length;
  }
}

// Drizzle's row shape comes back close to BulkActionJobRow but with
// `status` typed as `string` rather than the literal union. Cast here
// so the rest of the codebase gets the narrower type without dialect
// boilerplate at every call site.
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
