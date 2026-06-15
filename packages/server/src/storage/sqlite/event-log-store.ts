import { gt, and, eq, lt, isNull, sql } from "drizzle-orm";
import type { EventLogStore, PersistedEvent } from "../interface.js";
import { eventLog } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteEventLogStore implements EventLogStore {
  constructor(private db: DrizzleDb) {}

  async append(entry: {
    event_type: string;
    item_id?: string | null;
    edge_id?: string | null;
    tenant_id?: string;
    payload: string;
    originating_connection_id?: string | null;
    hop_count?: number;
  }): Promise<bigint> {
    const result = await this.db.run(sql`
      INSERT INTO event_log (event_type, item_id, edge_id, tenant_id, payload, originating_connection_id, hop_count, created_at)
      VALUES (${entry.event_type}, ${entry.item_id ?? null}, ${entry.edge_id ?? null}, ${entry.tenant_id ?? null}, ${entry.payload}, ${entry.originating_connection_id ?? null}, ${entry.hop_count ?? 0}, ${new Date().toISOString()})
    `);
    // libsql returns lastInsertRowid as `bigint`. Match better-sqlite3's prior
    // behavior of normalizing to bigint either way so the public wire shape
    // is identical to the PG side.
    const id = result.lastInsertRowid;
    if (id == null) {
      throw new Error("event_log insert did not return a rowid");
    }
    return typeof id === "bigint" ? id : BigInt(id);
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

    const rows = await this.db
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

  async cleanup(
    retentionHours: number,
    tenantId?: string | null,
  ): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionHours * 3_600_000,
    ).toISOString();
    // Three filter shapes (see audit-store.cleanup).
    const tenantClause =
      tenantId === undefined
        ? undefined
        : tenantId === null
          ? isNull(eventLog.tenant_id)
          : eq(eventLog.tenant_id, tenantId);
    const where =
      tenantClause === undefined
        ? lt(eventLog.created_at, cutoff)
        : and(lt(eventLog.created_at, cutoff), tenantClause);
    const result = await this.db.delete(eventLog).where(where).run();
    return result.rowsAffected;
  }

  async getMinRetainedId(tenantId?: string): Promise<bigint | null> {
    const result = tenantId
      ? await this.db.get<{ min: number | bigint | null }>(
          sql`SELECT MIN(id) AS min FROM event_log WHERE tenant_id = ${tenantId}`,
        )
      : await this.db.get<{ min: number | bigint | null }>(
          sql`SELECT MIN(id) AS min FROM event_log`,
        );
    if (result.min == null) return null;
    return typeof result.min === "bigint" ? result.min : BigInt(result.min);
  }
}
