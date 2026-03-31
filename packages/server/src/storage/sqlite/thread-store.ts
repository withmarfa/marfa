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

  create(): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: generateId(),
      created_at: now,
      updated_at: now,
    };
    this.db.insert(threads).values(thread).run();
    return thread;
  }

  get(id: string): Thread | null {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    return row ?? null;
  }

  list(limit: number, cursor?: string): PaginatedResult<Thread> {
    let query = this.db
      .select()
      .from(threads)
      .orderBy(desc(threads.created_at), desc(threads.id))
      .limit(limit + 1)
      .$dynamic();

    if (cursor) {
      const { v, id } = decodeCursor(cursor);
      query = query.where(
        or(
          lt(threads.created_at, v),
          and(eq(threads.created_at, v), lt(threads.id, id)),
        ),
      );
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

  touch(id: string): void {
    this.db
      .update(threads)
      .set({ updated_at: new Date().toISOString() })
      .where(eq(threads.id, id))
      .run();
  }

  getItems(threadId: string): Item[] {
    const rows = this.db
      .select()
      .from(items)
      .where(eq(items.thread_id, threadId))
      .orderBy(items.timestamp)
      .all();
    return rows.map(rowToItem);
  }
}
