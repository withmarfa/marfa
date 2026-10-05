import { and, eq, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import type {
  BackgroundJobFinish,
  BackgroundJobOutcome,
  BackgroundJobRow,
  BackgroundJobStore,
} from "../interface.js";
import type { BackgroundJobReport } from "../../background-jobs/scheduler.js";
import { backgroundJobs } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

type Row = typeof backgroundJobs.$inferSelect;

/**
 * What the column holds, read as what the door declares.
 *
 * The column is written from a `BackgroundJobReport`, but a row survives the
 * build that wrote it: an instance upgraded across this change holds
 * whatever the previous scheduler's jobs returned, which was anything at
 * all. A value that is not a flat object of scalars is dropped rather than
 * served, because the door declares scalars and a caller reading the
 * declaration would be handed something else. The whole report goes, not
 * the one value: a report with a count removed reads as a run that did less
 * than it did, and no report at all is what the door says for a name that
 * has never run.
 */
function toReport(raw: string): BackgroundJobReport | null {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const out: BackgroundJobReport = {};
  for (const [name, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "string"
    ) {
      out[name] = value;
    } else {
      return null;
    }
  }
  return out;
}

function toRow(row: Row): BackgroundJobRow {
  return {
    name: row.name,
    interval_ms: row.interval_ms,
    next_run_at: row.next_run_at,
    running_since: row.running_since,
    last_started_at: row.last_started_at,
    last_finished_at: row.last_finished_at,
    last_outcome: row.last_outcome as BackgroundJobOutcome | null,
    last_error: row.last_error,
    last_result: row.last_result === null ? null : toReport(row.last_result),
  };
}

export class SqliteBackgroundJobStore implements BackgroundJobStore {
  constructor(private db: DrizzleDb) {}

  async upsert(
    name: string,
    intervalMs: number,
    nextRunAt: string,
  ): Promise<void> {
    await this.db
      .insert(backgroundJobs)
      .values({ name, interval_ms: intervalMs, next_run_at: nextRunAt })
      .onConflictDoUpdate({
        target: backgroundJobs.name,
        set: {
          interval_ms: intervalMs,
          next_run_at: sql`min(${backgroundJobs.next_run_at}, ${nextRunAt})`,
        },
      })
      .run();
  }

  async removeExcept(names: readonly string[]): Promise<string[]> {
    const rows = await this.db
      .delete(backgroundJobs)
      .where(
        names.length > 0
          ? notInArray(backgroundJobs.name, [...names])
          : sql`1 = 1`,
      )
      .returning({ name: backgroundJobs.name })
      .all();
    return rows.map((row) => row.name);
  }

  async clearRunning(): Promise<string[]> {
    const rows = await this.db
      .update(backgroundJobs)
      .set({ running_since: null })
      .where(isNotNull(backgroundJobs.running_since))
      .returning({ name: backgroundJobs.name })
      .all();
    return rows.map((row) => row.name);
  }

  async listDue(now: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: backgroundJobs.name })
      .from(backgroundJobs)
      .where(
        and(
          isNull(backgroundJobs.running_since),
          lte(backgroundJobs.next_run_at, now),
        ),
      )
      .orderBy(backgroundJobs.next_run_at)
      .all();
    return rows.map((row) => row.name);
  }

  async claimDue(name: string, now: string): Promise<BackgroundJobRow | null> {
    const rows = await this.db
      .update(backgroundJobs)
      .set({ running_since: now, last_started_at: now })
      .where(
        and(
          eq(backgroundJobs.name, name),
          isNull(backgroundJobs.running_since),
          lte(backgroundJobs.next_run_at, now),
        ),
      )
      .returning()
      .all();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async claim(name: string, now: string): Promise<BackgroundJobRow | null> {
    const rows = await this.db
      .update(backgroundJobs)
      .set({ running_since: now, last_started_at: now })
      .where(
        and(
          eq(backgroundJobs.name, name),
          isNull(backgroundJobs.running_since),
        ),
      )
      .returning()
      .all();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async finish(name: string, outcome: BackgroundJobFinish): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({
        running_since: null,
        last_finished_at: outcome.finishedAt,
        last_outcome: outcome.outcome,
        last_error: outcome.error,
        last_result:
          outcome.result === null ? null : JSON.stringify(outcome.result),
        // A `next_run_at` past the run's start is either a wake that arrived
        // during the run or the schedule of a run started ahead of it, and
        // either holds unless the interval falls earlier; a run started on
        // or after its schedule sets the next one. Compared as ISO strings,
        // which order as instants do.
        next_run_at: sql`CASE WHEN ${backgroundJobs.next_run_at} > ${backgroundJobs.running_since} THEN min(${backgroundJobs.next_run_at}, ${outcome.nextRunAt}) ELSE ${outcome.nextRunAt} END`,
      })
      .where(eq(backgroundJobs.name, name))
      .run();
  }

  async wake(name: string, now: string): Promise<boolean> {
    // Read the claim in the same writer statement as the wake: a preceding
    // snapshot can miss a claim or finish. A live run's hint is strictly
    // after its start so finish preserves even a same-millisecond wake.
    const result = await this.db
      .update(backgroundJobs)
      .set({
        next_run_at: sql`CASE WHEN ${backgroundJobs.running_since} IS NULL THEN min(${backgroundJobs.next_run_at}, ${now}) ELSE max(${now}, strftime('%Y-%m-%dT%H:%M:%fZ', ${backgroundJobs.running_since}, '+0.001 seconds')) END`,
      })
      .where(eq(backgroundJobs.name, name))
      .run();
    return result.rowsAffected > 0;
  }

  async list(): Promise<BackgroundJobRow[]> {
    const rows = await this.db
      .select()
      .from(backgroundJobs)
      .orderBy(backgroundJobs.name)
      .all();
    return rows.map(toRow);
  }

  async get(name: string): Promise<BackgroundJobRow | null> {
    const row = await this.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.name, name))
      .get();
    return row ? toRow(row) : null;
  }
}
