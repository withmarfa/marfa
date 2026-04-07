/* eslint-disable @typescript-eslint/require-await -- sync better-sqlite3 implementing async interface */
import { eq, desc, or, and, lt } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { Thread, PaginatedResult, Item } from "@myme/shared";
import type { ThreadStore } from "../interface.js";
import { encodeCursor, decodeCursor } from "../interface.js";
import { threads, items } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { rowToItem } from "./helpers.js";

export class SqliteThreadStore implements ThreadStore {
  constructor(private db: DrizzleDb) {}

  async create(tenantId?: string): Promise<Thread> {
    const now = new Date().toISOString();
    const id = generateId();
    this.db
      .insert(threads)
      .values({
        id,
        tenant_id: tenantId,
        created_at: now,
        updated_at: now,
      })
      .run();
    return { id, created_at: now, updated_at: now };
  }

  async get(id: string, tenantId?: string): Promise<Thread | null> {
    const where = tenantId
      ? and(eq(threads.id, id), eq(threads.tenant_id, tenantId))
      : eq(threads.id, id);
    const row = this.db.select().from(threads).where(where).get();
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
      const cursorClause = or(
        lt(threads.created_at, v),
        and(eq(threads.created_at, v), lt(threads.id, id)),
      );
      if (cursorClause) conditions.push(cursorClause);
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

    const rows = query.all();
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
    this.db
      .update(threads)
      .set({ updated_at: new Date().toISOString() })
      .where(eq(threads.id, id))
      .run();
  }

  async getItems(threadId: string, tenantId?: string): Promise<Item[]> {
    const where = tenantId
      ? and(eq(items.thread_id, threadId), eq(items.tenant_id, tenantId))
      : eq(items.thread_id, threadId);
    const rows = this.db
      .select()
      .from(items)
      .where(where)
      .orderBy(items.timestamp)
      .all();
    return rows.map(rowToItem);
  }
}
