import { gt, and, eq, lt, sql } from "drizzle-orm";
import type { EventLogStore, PersistedEvent } from "../interface.js";
import { eventLog } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgEventLogStore implements EventLogStore {
  constructor(private db: PgDb) {}

  async append(entry: {
    event_type: string;
    item_id?: string | null;
    edge_id?: string | null;
    tenant_id?: string;
    payload: string;
    originating_connection_id?: string | null;
    hop_count?: number;
  }): Promise<number> {
    const [row] = await this.db
      .insert(eventLog)
      .values({
        event_type: entry.event_type,
        item_id: entry.item_id ?? null,
        edge_id: entry.edge_id ?? null,
        tenant_id: entry.tenant_id ?? null,
        payload: entry.payload,
        originating_connection_id: entry.originating_connection_id ?? null,
        hop_count: entry.hop_count ?? 0,
        created_at: new Date().toISOString(),
      })
      .returning({ id: eventLog.id });
    if (!row) {
      throw new Error("event_log insert returned no row");
    }
    return row.id;
  }

  async getAfter(
    afterId: number,
    limit: number,
    tenantId?: string,
  ): Promise<PersistedEvent[]> {
    const conditions = [gt(eventLog.id, afterId)];
    if (tenantId) conditions.push(eq(eventLog.tenant_id, tenantId));

    const rows = await this.db
      .select()
      .from(eventLog)
      .where(and(...conditions))
      .orderBy(eventLog.id)
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
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
    const rows = await this.db
      .delete(eventLog)
      .where(lt(eventLog.created_at, cutoff))
      .returning({ id: eventLog.id });
    return rows.length;
  }

  async getMinRetainedId(tenantId?: string): Promise<number | null> {
    const query = this.db
      .select({ min: sql<number | null>`MIN(${eventLog.id})` })
      .from(eventLog);
    const rows = tenantId
      ? await query.where(eq(eventLog.tenant_id, tenantId))
      : await query;
    const min = rows[0]?.min ?? null;
    if (min === null) return null;
    // pg may drive us back a string/bigint for the aggregate; normalise.
    return typeof min === "number" ? min : Number(min);
  }
}
