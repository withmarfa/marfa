import { and, eq, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import type {
  HousekeepingFinish,
  HousekeepingOutcome,
  HousekeepingRow,
  HousekeepingStore,
} from "../interface.js";
import { housekeeping } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

type Row = typeof housekeeping.$inferSelect;

function toRow(row: Row): HousekeepingRow {
  return {
    name: row.name,
    interval_ms: row.interval_ms,
    next_run_at: row.next_run_at,
    running_since: row.running_since,
    last_started_at: row.last_started_at,
    last_finished_at: row.last_finished_at,
    last_outcome: row.last_outcome as HousekeepingOutcome | null,
    last_error: row.last_error,
    last_result:
      row.last_result === null
        ? null
        : (JSON.parse(row.last_result) as Record<
            string,
            number | boolean | string | null
          >),
  };
}

export class SqliteHousekeepingStore implements HousekeepingStore {
  constructor(private db: DrizzleDb) {}

  async upsert(
    name: string,
    intervalMs: number,
    nextRunAt: string,
  ): Promise<void> {
    await this.db
      .insert(housekeeping)
      .values({ name, interval_ms: intervalMs, next_run_at: nextRunAt })
      .onConflictDoUpdate({
        target: housekeeping.name,
        set: {
          interval_ms: intervalMs,
          next_run_at: sql`min(${housekeeping.next_run_at}, ${nextRunAt})`,
        },
      })
      .run();
  }

  async removeExcept(names: readonly string[]): Promise<string[]> {
    const rows = await this.db
      .delete(housekeeping)
      .where(
        names.length > 0
          ? notInArray(housekeeping.name, [...names])
          : sql`1 = 1`,
      )
      .returning({ name: housekeeping.name })
      .all();
    return rows.map((row) => row.name);
  }

  async clearRunning(): Promise<string[]> {
    const rows = await this.db
      .update(housekeeping)
      .set({ running_since: null })
      .where(isNotNull(housekeeping.running_since))
      .returning({ name: housekeeping.name })
      .all();
    return rows.map((row) => row.name);
  }

  async listDue(now: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: housekeeping.name })
      .from(housekeeping)
      .where(
        and(
          isNull(housekeeping.running_since),
          lte(housekeeping.next_run_at, now),
        ),
      )
      .orderBy(housekeeping.next_run_at)
      .all();
    return rows.map((row) => row.name);
  }

  async claimDue(name: string, now: string): Promise<HousekeepingRow | null> {
    const rows = await this.db
      .update(housekeeping)
      .set({ running_since: now, last_started_at: now })
      .where(
        and(
          eq(housekeeping.name, name),
          isNull(housekeeping.running_since),
          lte(housekeeping.next_run_at, now),
        ),
      )
      .returning()
      .all();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async claim(name: string, now: string): Promise<HousekeepingRow | null> {
    const rows = await this.db
      .update(housekeeping)
      .set({ running_since: now, last_started_at: now })
      .where(
        and(eq(housekeeping.name, name), isNull(housekeeping.running_since)),
      )
      .returning()
      .all();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async finish(name: string, outcome: HousekeepingFinish): Promise<void> {
    await this.db
      .update(housekeeping)
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
        next_run_at: sql`CASE WHEN ${housekeeping.next_run_at} > ${housekeeping.running_since} THEN min(${housekeeping.next_run_at}, ${outcome.nextRunAt}) ELSE ${outcome.nextRunAt} END`,
      })
      .where(eq(housekeeping.name, name))
      .run();
  }

  async wake(name: string, now: string): Promise<boolean> {
    const row = await this.get(name);
    if (!row) return false;
    // A name in the middle of a run is marked due strictly after its start,
    // so `finish` can tell the wake from the schedule the run was claimed
    // under and keep it; a wake in the same millisecond as the claim would
    // otherwise be lost to that comparison.
    const due =
      row.running_since !== null && row.running_since >= now
        ? new Date(new Date(row.running_since).getTime() + 1).toISOString()
        : now;
    await this.db
      .update(housekeeping)
      .set({
        next_run_at:
          row.running_since === null
            ? sql`min(${housekeeping.next_run_at}, ${due})`
            : due,
      })
      .where(eq(housekeeping.name, name))
      .run();
    return true;
  }

  async list(): Promise<HousekeepingRow[]> {
    const rows = await this.db
      .select()
      .from(housekeeping)
      .orderBy(housekeeping.name)
      .all();
    return rows.map(toRow);
  }

  async get(name: string): Promise<HousekeepingRow | null> {
    const row = await this.db
      .select()
      .from(housekeeping)
      .where(eq(housekeeping.name, name))
      .get();
    return row ? toRow(row) : null;
  }
}
