import { eq, desc, or, and, lt, inArray } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { Thread, PaginatedResult, Item } from "@mymehq/shared";
import type { ThreadStore } from "../interface.js";
import { encodeCursor, decodeCursor } from "../interface.js";
import { threads, items, edges } from "./schema.js";
import type { PgDb } from "./connection.js";
import { rowToItem } from "./helpers.js";

export class PgThreadStore implements ThreadStore {
  constructor(private db: PgDb) {}

  async create(tenantId?: string): Promise<Thread> {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: generateId(),
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(threads).values({
      ...thread,
      tenant_id: tenantId,
    });
    return thread;
  }

  async get(id: string, tenantId?: string): Promise<Thread | null> {
    const where = tenantId
      ? and(eq(threads.id, id), eq(threads.tenant_id, tenantId))
      : eq(threads.id, id);
    const [row] = await this.db.select().from(threads).where(where);
    return row ?? null;
  }

  async list(
    limit: number,
    cursor?: string,
    tenantId?: string,
  ): Promise<PaginatedResult<Thread>> {
    const conditions = [];
    if (tenantId) conditions.push(eq(threads.tenant_id, tenantId));

    if (cursor) {
      const { v, id } = decodeCursor(cursor);
      const cursorCondition = or(
        lt(threads.created_at, v),
        and(eq(threads.created_at, v), lt(threads.id, id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }

    let query = this.db
      .select()
      .from(threads)
      .orderBy(desc(threads.created_at), desc(threads.id))
      .limit(limit + 1)
      .$dynamic();

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = await query;
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = data.at(-1);
      if (!last) throw new Error("unreachable: hasMore but data is empty");
      nextCursor = encodeCursor(last.created_at, last.id);
    }

    return { data, cursor: nextCursor, has_more: hasMore };
  }

  async touch(id: string): Promise<void> {
    await this.db
      .update(threads)
      .set({ updated_at: new Date().toISOString() })
      .where(eq(threads.id, id));
  }

  async getItems(threadId: string, tenantId?: string): Promise<Item[]> {
    // Thread membership lives in in-thread edges (source=member, target=thread).
    // Read via join, ordered by edge properties.position (backfill fills it)
    // and falling back to item timestamp for edges created without position.
    const memberEdges = await this.db
      .select({
        item_id: edges.source_id,
        properties: edges.properties,
      })
      .from(edges)
      .where(
        and(eq(edges.target_id, threadId), eq(edges.edge_type, "in-thread")),
      );
    if (memberEdges.length === 0) return [];
    const itemIds = memberEdges.map((e) => e.item_id);
    const where = tenantId
      ? and(inArray(items.id, itemIds), eq(items.tenant_id, tenantId))
      : inArray(items.id, itemIds);
    const rows = await this.db
      .select()
      .from(items)
      .where(where)
      .orderBy(items.timestamp);
    return rows.map(rowToItem);
  }
}
