import { gt, and, eq, lt } from "drizzle-orm";
import type { EventLogStore, PersistedEvent } from "../interface.js";
import { eventLog } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgEventLogStore implements EventLogStore {
  constructor(private db: PgDb) {}

  async append(entry: {
    event_type: string;
    item_id: string;
    tenant_id?: string;
    payload: string;
  }): Promise<number> {
    const [row] = await this.db
      .insert(eventLog)
      .values({
        event_type: entry.event_type,
        item_id: entry.item_id,
        tenant_id: entry.tenant_id ?? null,
        payload: entry.payload,
        created_at: new Date().toISOString(),
      })
      .returning({ id: eventLog.id });
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
      tenant_id: row.tenant_id,
      payload: row.payload,
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
}
