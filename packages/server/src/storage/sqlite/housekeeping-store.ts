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
        : (JSON.parse(row.last_result) as unknown),
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
          outcome.result === undefined ? null : JSON.stringify(outcome.result),
        // A wake during the run moved `next_run_at` past the run's start, and
        // the earlier of the two is what holds; otherwise the run sets the
        // next one. Compared as ISO strings, which order as instants do.
        next_run_at: sql`CASE WHEN ${housekeeping.next_run_at} > ${housekeeping.running_since} THEN min(${housekeeping.next_run_at}, ${outcome.nextRunAt}) ELSE ${outcome.nextRunAt} END`,
      })
      .where(eq(housekeeping.name, name))
      .run();
  }

  async wake(name: string, now: string): Promise<boolean> {
    // A job in the middle of a run is marked due at `now`, which is after
    // its start, so `finish` can tell the wake from the schedule the run
    // was claimed under and keep it.
    const rows = await this.db
      .update(housekeeping)
      .set({
        next_run_at: sql`CASE WHEN ${housekeeping.running_since} IS NOT NULL THEN ${now} ELSE min(${housekeeping.next_run_at}, ${now}) END`,
      })
      .where(eq(housekeeping.name, name))
      .returning({ name: housekeeping.name })
      .all();
    return rows.length > 0;
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
