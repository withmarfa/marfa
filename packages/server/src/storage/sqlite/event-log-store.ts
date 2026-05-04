import { gt, and, eq, lt } from "drizzle-orm";
import type { EventLogStore, PersistedEvent } from "../interface.js";
import { eventLog } from "./schema.js";
import type { DrizzleDb, RawDb } from "./connection.js";

export class SqliteEventLogStore implements EventLogStore {
  constructor(
    private db: DrizzleDb,
    private raw: RawDb,
  ) {}

  async append(entry: {
    event_type: string;
    item_id?: string | null;
    edge_id?: string | null;
    tenant_id?: string;
    payload: string;
    originating_connection_id?: string | null;
    hop_count?: number;
  }): Promise<bigint> {
    const stmt = this.raw.prepare(
      `INSERT INTO event_log (event_type, item_id, edge_id, tenant_id, payload, originating_connection_id, hop_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      entry.event_type,
      entry.item_id ?? null,
      entry.edge_id ?? null,
      entry.tenant_id ?? null,
      entry.payload,
      entry.originating_connection_id ?? null,
      entry.hop_count ?? 0,
      new Date().toISOString(),
    );
    // better-sqlite3 returns lastInsertRowid as `number | bigint`; the row id
    // is i64 underneath. Normalise to `bigint` so PG and SQLite present the
    // same wire type to the rest of the server.
    return typeof result.lastInsertRowid === "bigint"
      ? result.lastInsertRowid
      : BigInt(result.lastInsertRowid);
  }

  async getAfter(
    afterId: bigint,
    limit: number,
    tenantId?: string,
  ): Promise<PersistedEvent[]> {
    // SQLite Drizzle binds JS numbers; the row's id is stored as INTEGER (i64).
    // Convert the bigint cursor to number for the bind, then re-bigint each
    // returned id so the public PersistedEvent shape matches PG's bigint.
    const conditions = [gt(eventLog.id, Number(afterId))];
    if (tenantId) conditions.push(eq(eventLog.tenant_id, tenantId));

    const rows = this.db
      .select()
      .from(eventLog)
      .where(and(...conditions))
      .orderBy(eventLog.id)
      .limit(limit)
      .all();

    return rows.map((row) => ({
      id: BigInt(row.id),
      event_type: row.event_type,
      item_id: row.item_id,
      edge_id: row.edge_id,
      tenant_id: row.tenant_id,
      payload: row.payload,
      originating_connection_id: row.originating_connection_id,
      hop_count: row.hop_count,
      created_at: row.created_at,
    }));
  }

  async cleanup(retentionHours: number): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionHours * 3_600_000,
    ).toISOString();
    const result = this.db
      .delete(eventLog)
      .where(lt(eventLog.created_at, cutoff))
      .run();
    return result.changes;
  }

  async getMinRetainedId(tenantId?: string): Promise<bigint | null> {
    const row = (
      tenantId
        ? this.raw
            .prepare(`SELECT MIN(id) AS min FROM event_log WHERE tenant_id = ?`)
            .get(tenantId)
        : this.raw.prepare(`SELECT MIN(id) AS min FROM event_log`).get()
    ) as { min: number | bigint | null } | undefined;
    if (row?.min == null) return null;
    return typeof row.min === "bigint" ? row.min : BigInt(row.min);
  }
}
