/* eslint-disable no-restricted-syntax -- Not yet on the shared space
 * fence. `storage/space-condition.ts` is the one spelling of it, and
 * this store predates it; the rule covers every store so a new file is
 * covered by default, which leaves the existing ones needing a line
 * that says so. Normalizing one is a change of its own: an absent space
 * has to be read call site by call site, and reading it wrong is the
 * defect the helper exists for. Delete this line when you do. */
import { gt, and, eq, lt, sql, isNull } from "drizzle-orm";
import type { EventLogStore, PersistedEvent } from "../interface.js";
import { eventLog } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgEventLogStore implements EventLogStore {
  constructor(private db: PgDb) {}

  async append(entry: {
    event_type: string;
    item_id?: string | null;
    edge_id?: string | null;
    space_id?: string;
    payload: string;
    originating_connection_id?: string | null;
    hop_count?: number;
    enable_fanout?: boolean;
  }): Promise<bigint> {
    const [row] = await this.db
      .insert(eventLog)
      .values({
        event_type: entry.event_type,
        item_id: entry.item_id ?? null,
        edge_id: entry.edge_id ?? null,
        space_id: entry.space_id ?? null,
        payload: entry.payload,
        originating_connection_id: entry.originating_connection_id ?? null,
        hop_count: entry.hop_count ?? 0,
        enable_fanout: entry.enable_fanout ?? true,
        created_at: new Date().toISOString(),
      })
      .returning({ id: eventLog.id });
    if (!row) {
      throw new Error("event_log insert returned no row");
    }
    return row.id;
  }

  async getAfter(
    afterId: bigint,
    limit: number,
    spaceId?: string,
  ): Promise<PersistedEvent[]> {
    const conditions = [gt(eventLog.id, afterId)];
    if (spaceId) conditions.push(eq(eventLog.space_id, spaceId));

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
      space_id: row.space_id,
      payload: row.payload,
      originating_connection_id: row.originating_connection_id,
      hop_count: row.hop_count,
      enable_fanout: row.enable_fanout,
      created_at: row.created_at,
    }));
  }

  async cleanup(
    retentionHours: number,
    spaceId?: string | null,
  ): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionHours * 3_600_000,
    ).toISOString();
    // Three filter shapes (see audit-store.cleanup).
    const spaceClause =
      spaceId === undefined
        ? undefined
        : spaceId === null
          ? isNull(eventLog.space_id)
          : eq(eventLog.space_id, spaceId);
    const where =
      spaceClause === undefined
        ? lt(eventLog.created_at, cutoff)
        : and(lt(eventLog.created_at, cutoff), spaceClause);
    const rows = await this.db
      .delete(eventLog)
      .where(where)
      .returning({ id: eventLog.id });
    return rows.length;
  }

  async getMaxId(spaceId?: string): Promise<bigint | null> {
    const query = this.db
      .select({ max: sql<bigint | null>`MAX(${eventLog.id})` })
      .from(eventLog);
    const rows = spaceId
      ? await query.where(eq(eventLog.space_id, spaceId))
      : await query;
    const max = rows[0]?.max ?? null;
    if (max === null) return null;
    // pg returns aggregate as string; normalize to bigint.
    return typeof max === "bigint" ? max : BigInt(max);
  }

  async getMinRetainedId(spaceId?: string): Promise<bigint | null> {
    const query = this.db
      .select({ min: sql<bigint | null>`MIN(${eventLog.id})` })
      .from(eventLog);
    const rows = spaceId
      ? await query.where(eq(eventLog.space_id, spaceId))
      : await query;
    const min = rows[0]?.min ?? null;
    if (min === null) return null;
    // pg returns aggregate as string; normalize to bigint.
    return typeof min === "bigint" ? min : BigInt(min);
  }
}
