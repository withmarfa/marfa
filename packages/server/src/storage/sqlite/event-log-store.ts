import { sql } from "drizzle-orm";
import type { EventLogStore, PersistedEvent } from "../interface.js";
import { eventLog } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteEventLogStore implements EventLogStore {
  constructor(private db: DrizzleDb) {}

  async append(entry: {
    event_type: string;
    item_id?: string | null;
    edge_id?: string | null;
    payload: string;
    enable_fanout?: boolean;
  }): Promise<bigint> {
    const result = await this.db.run(sql`
      INSERT INTO event_log (event_type, item_id, edge_id, payload, enable_fanout, created_at)
      VALUES (${entry.event_type}, ${entry.item_id ?? null}, ${entry.edge_id ?? null}, ${entry.payload}, ${(entry.enable_fanout ?? true) ? 1 : 0}, ${new Date().toISOString()})
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
    options: { maxBytes?: number } = {},
  ): Promise<PersistedEvent[]> {
    const take =
      options.maxBytes === undefined
        ? limit
        : await this.rowsWithin(afterId, limit, options.maxBytes);
    // The row's id is an INTEGER (i64) and the cursor a bigint. Compared as
    // an integer on the SQLite side rather than through a JS number, which
    // loses precision past 2^53 and would then skip or repeat rows at the
    // top of a long log; each returned id is re-bigint'd so the public
    // PersistedEvent shape carries a bigint.
    const rows = await this.db
      .select()
      .from(eventLog)
      .where(sql`${eventLog.id} > CAST(${afterId.toString()} AS INTEGER)`)
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

  /** How many of the next `limit` rows start within `maxBytes` of
   *  payload, counted without reading the payloads into this process. */
  private async rowsWithin(
    afterId: bigint,
    limit: number,
    maxBytes: number,
  ): Promise<number> {
    const row = await this.db.get<{ rows: number | bigint }>(sql`
      SELECT count(*) AS rows FROM (
        SELECT SUM(size) OVER (ORDER BY id) - size AS before FROM (
          SELECT id, length(CAST(payload AS BLOB)) AS size FROM event_log
          WHERE id > CAST(${afterId.toString()} AS INTEGER)
          ORDER BY id LIMIT ${limit}
        )
      ) WHERE before < ${maxBytes}
    `);
    return Number(row.rows);
  }

  async cleanup(retentionHours: number): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionHours * 3_600_000,
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

  async getMaxId(): Promise<bigint | null> {
    const result = await this.db.get<{ max: number | bigint | null }>(
      sql`SELECT MAX(id) AS max FROM event_log`,
    );
    if (result.max == null) return null;
    return typeof result.max === "bigint" ? result.max : BigInt(result.max);
  }

  async getMinRetainedId(): Promise<bigint | null> {
    const result = await this.db.get<{ min: number | bigint | null }>(
      sql`SELECT MIN(id) AS min FROM event_log`,
    );
    if (result.min == null) return null;
    return typeof result.min === "bigint" ? result.min : BigInt(result.min);
  }
}
