import { sql } from "drizzle-orm";
import type {
  EventLogStore,
  HiddenEventIds,
  PersistedEvent,
} from "../interface.js";
import { eventLog } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import * as clock from "../../clock.js";
import { failAt } from "../../control/faults.js";

const STAMPED_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/** A condition on `event_log.id` that leaves out the events a read treats as absent. */
function unhidden(hidden: HiddenEventIds | undefined) {
  return hidden === undefined
    ? sql`1`
    : sql`event_log.id NOT BETWEEN CAST(${hidden.first.toString()} AS INTEGER) AND CAST(${hidden.last.toString()} AS INTEGER)`;
}

export class SqliteEventLogStore implements EventLogStore {
  constructor(private db: DrizzleDb) {}

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      sql`SELECT count(*) AS n FROM event_log`,
    );
    return row.n;
  }

  async append(entry: {
    event_type: string;
    item_id?: string | null;
    edge_id?: string | null;
    payload: string;
    enable_fanout?: boolean;
  }): Promise<bigint> {
    const stamp = new Date(
      clock.now().getTime() + (failAt("event-stamp") ? STAMPED_AHEAD_MS : 0),
    );
    const result = await this.db.run(sql`
      INSERT INTO event_log (event_type, item_id, edge_id, payload, enable_fanout, created_at)
      VALUES (${entry.event_type}, ${entry.item_id ?? null}, ${entry.edge_id ?? null}, ${entry.payload}, ${(entry.enable_fanout ?? true) ? 1 : 0}, ${stamp.toISOString()})
    `);
    // libsql returns lastInsertRowid as a `bigint` or a number depending on
    // the driver build; normalized to bigint either way so the public wire
    // shape is one thing.
    const id = result.lastInsertRowid;
    if (id == null) {
      throw new Error("event_log insert did not return a rowid");
    }
    return typeof id === "bigint" ? id : BigInt(id);
  }

  async getAfter(
    afterId: bigint,
    limit: number,
    options: { maxBytes?: number; hidden?: HiddenEventIds } = {},
  ): Promise<PersistedEvent[]> {
    const take =
      options.maxBytes === undefined
        ? limit
        : await this.rowsWithin(
            afterId,
            limit,
            options.maxBytes,
            options.hidden,
          );
    // The row's id is an INTEGER (i64) and the cursor a bigint. Compared as
    // an integer on the SQLite side rather than through a JS number, which
    // loses precision past 2^53 and would then skip or repeat rows at the
    // top of a long log; each returned id is re-bigint'd so the public
    // PersistedEvent shape carries a bigint.
    const rows = await this.db
      .select()
      .from(eventLog)
      .where(
        sql`${eventLog.id} > CAST(${afterId.toString()} AS INTEGER) AND ${unhidden(options.hidden)}`,
      )
      .orderBy(eventLog.id)
      .limit(take)
      .all();

    return rows.map((row) => ({
      id: BigInt(row.id),
      event_type: row.event_type,
      item_id: row.item_id,
      edge_id: row.edge_id,
      payload: row.payload,
      enable_fanout: row.enable_fanout,
      created_at: row.created_at,
    }));
  }

  async getNonFanoutEnd(
    afterId: bigint,
    headId: bigint,
    hidden?: HiddenEventIds,
  ): Promise<bigint> {
    if (afterId > headId)
      throw new Error("Outbound webhook checkpoint is ahead of the event log");
    // Count only IDs and flags: even an oversized payload must not hold
    // back unrelated fan-out. The count also proves there is no internal
    // hole, which a minimum/maximum check alone cannot establish.
    const row = await this.db.get<{ end_id: string; skipped: string }>(sql`
      WITH boundary AS MATERIALIZED (
        SELECT COALESCE(
          (SELECT MIN(id) - 1 FROM event_log
           WHERE id > CAST(${afterId.toString()} AS INTEGER)
             AND id <= CAST(${headId.toString()} AS INTEGER)
             AND enable_fanout != 0 AND ${unhidden(hidden)}),
          CAST(${headId.toString()} AS INTEGER)
        ) AS id
      )
      SELECT CAST(id AS TEXT) AS end_id,
        CAST((SELECT COUNT(*) FROM event_log
              WHERE event_log.id > CAST(${afterId.toString()} AS INTEGER)
                AND event_log.id <= boundary.id
                AND enable_fanout = 0 AND ${unhidden(hidden)}) AS TEXT) AS skipped
      FROM boundary
    `);
    const end = BigInt(row.end_id);
    if (BigInt(row.skipped) !== end - afterId)
      throw new Error("Outbound webhook event log is inconsistent");
    return end;
  }

  /** How many of the next `limit` rows start within `maxBytes` of
   *  payload. `octet_length` reads each size from the row's header, so no
   *  payload is loaded to count it. */
  private async rowsWithin(
    afterId: bigint,
    limit: number,
    maxBytes: number,
    hidden: HiddenEventIds | undefined,
  ): Promise<number> {
    const row = await this.db.get<{ rows: number | bigint }>(sql`
      SELECT count(*) AS rows FROM (
        SELECT SUM(size) OVER (ORDER BY id) - size AS before FROM (
          SELECT id, octet_length(payload) AS size FROM event_log
          WHERE id > CAST(${afterId.toString()} AS INTEGER) AND ${unhidden(hidden)}
          ORDER BY id LIMIT ${limit}
        )
      ) WHERE before < ${maxBytes}
    `);
    return Number(row.rows);
  }

  async cleanup(retentionHours: number): Promise<number> {
    const cutoff = new Date(
      clock.nowMs() - retentionHours * 3_600_000,
    ).toISOString();
    // Cut by id, below the oldest row still within retention, and never the
    // newest row. `append` stamps a row before its insert waits for the
    // write lock, so stamps are not monotonic in id; cutting by stamp could
    // retire a row above one it keeps, and an emptied log has no oldest id.
    // Either is a gap the stream's too-old check cannot see.
    const result = await this.db.run(sql`
      DELETE FROM event_log
      WHERE id < COALESCE(
        (SELECT MIN(id) FROM event_log WHERE created_at >= ${cutoff}),
        (SELECT MAX(id) FROM event_log)
      )
    `);
    return result.rowsAffected;
  }

  async getMaxId(hidden?: HiddenEventIds): Promise<bigint | null> {
    const result = await this.db.get<{ max: number | bigint | null }>(
      sql`SELECT MAX(id) AS max FROM event_log WHERE ${unhidden(hidden)}`,
    );
    if (result.max == null) return null;
    return typeof result.max === "bigint" ? result.max : BigInt(result.max);
  }

  async getMinRetainedId(hidden?: HiddenEventIds): Promise<bigint | null> {
    const result = await this.db.get<{ min: number | bigint | null }>(
      sql`SELECT MIN(id) AS min FROM event_log WHERE ${unhidden(hidden)}`,
    );
    if (result.min == null) return null;
    return typeof result.min === "bigint" ? result.min : BigInt(result.min);
  }
}
