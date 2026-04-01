import { eq, desc } from "drizzle-orm";
import type { Thread, PaginatedResult } from "@myme/shared";
import type { LocalDb } from "../connection.js";
import { threads } from "../schema.js";
import { rowToThread } from "../helpers.js";

export class LocalThreadStore {
  constructor(private db: LocalDb) {}

  get(id: string): Thread | null {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) return null;
    return rowToThread(row as unknown as Record<string, unknown>);
  }

  list(limit = 50): PaginatedResult<Thread> {
    const rows = this.db
      .select()
      .from(threads)
      .orderBy(desc(threads.updated_at))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(
      (r) => rowToThread(r as unknown as Record<string, unknown>),
    );

    return {
      data,
      cursor: hasMore && data.length > 0 ? data.at(-1)?.id ?? null : null,
      has_more: hasMore,
    };
  }

  upsert(thread: Thread): void {
    this.db
      .insert(threads)
      .values({
        id: thread.id,
        created_at: thread.created_at,
        updated_at: thread.updated_at,
      })
      .onConflictDoUpdate({
        target: threads.id,
        set: { updated_at: thread.updated_at },
      })
      .run();
  }

  remove(id: string): void {
    this.db.delete(threads).where(eq(threads.id, id)).run();
  }
}
