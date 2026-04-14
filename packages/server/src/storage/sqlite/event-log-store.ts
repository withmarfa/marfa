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
  }): Promise<number> {
    const stmt = this.raw.prepare(
      `INSERT INTO event_log (event_type, item_id, edge_id, tenant_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      entry.event_type,
      entry.item_id ?? null,
      entry.edge_id ?? null,
      entry.tenant_id ?? null,
      entry.payload,
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  async getAfter(
    afterId: number,
    limit: number,
    tenantId?: string,
  ): Promise<PersistedEvent[]> {
    const conditions = [gt(eventLog.id, afterId)];
    if (tenantId) conditions.push(eq(eventLog.tenant_id, tenantId));

    const rows = this.db
      .select()
      .from(eventLog)
      .where(and(...conditions))
      .orderBy(eventLog.id)
      .limit(limit)
      .all();

    return rows.map((row) => ({
      id: row.id,
      event_type: row.event_type,
      item_id: row.item_id,
      edge_id: row.edge_id,
      tenant_id: row.tenant_id,
      payload: row.payload,
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
}
