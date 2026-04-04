import { eq, desc, and } from "drizzle-orm";
import type { Item, PaginatedResult, ItemState } from "@mymehq/shared";
import type { LocalDb } from "../connection.js";
import { items } from "../schema.js";
import { rowToItem } from "../helpers.js";

export class LocalItemStore {
  constructor(private db: LocalDb) {}

  get(id: string): Item | null {
    const row = this.db.select().from(items).where(eq(items.id, id)).get();
    if (!row) return null;
    return rowToItem(row as unknown as Record<string, unknown>);
  }

  list(filters?: {
    type?: string;
    state?: ItemState;
    limit?: number;
    cursor?: string;
  }): PaginatedResult<Item> {
    const limit = filters?.limit ?? 50;
    const conditions = [];

    if (filters?.type) conditions.push(eq(items.type, filters.type));
    if (filters?.state) conditions.push(eq(items.state, filters.state));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = this.db
      .select()
      .from(items)
      .where(where)
      .orderBy(desc(items.created_at))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map((r) =>
      rowToItem(r as unknown as Record<string, unknown>),
    );

    return {
      data,
      cursor: hasMore && data.length > 0 ? (data.at(-1)?.id ?? null) : null,
      has_more: hasMore,
    };
  }

  /** Upsert an item from Electric sync. */
  upsert(item: Item): void {
    this.db
      .insert(items)
      .values({
        id: item.id,
        type: item.type,
        state: item.state,
        properties: JSON.stringify(item.properties),
        created_at: item.created_at,
        updated_at: item.updated_at,
        timestamp: item.timestamp,
        source: item.source ?? null,
        source_id: item.source_id ?? null,
        origin: item.origin ?? null,
        version: item.version,
        schema_version: item.schema_version ?? null,
        device_id: item.device_id ?? null,
        parent_id: item.parent_id ?? null,
        thread_id: item.thread_id ?? null,
        capture_latitude: item.capture_latitude ?? null,
        capture_longitude: item.capture_longitude ?? null,
      })
      .onConflictDoUpdate({
        target: items.id,
        set: {
          type: item.type,
          state: item.state,
          properties: JSON.stringify(item.properties),
          updated_at: item.updated_at,
          timestamp: item.timestamp,
          version: item.version,
          device_id: item.device_id ?? null,
          parent_id: item.parent_id ?? null,
          thread_id: item.thread_id ?? null,
        },
      })
      .run();
  }

  /** Remove an item from local storage (used for Electric delete events). */
  remove(id: string): void {
    this.db.delete(items).where(eq(items.id, id)).run();
  }
}
