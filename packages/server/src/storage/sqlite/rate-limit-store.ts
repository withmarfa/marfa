/**
 * SQLite rate-limit / throttle counter store. Mirrors the PG sibling
 * step-for-step; see pg/rate-limit-store.ts for design notes.
 *
 * SQLite is single-process by file lock so "cluster-shared" collapses
 * to "still correct in-process". The same upsert codepath ships on both
 * dialects so single-tenant self-hosts behave identically to a hosted
 * single-instance — no dead code, no dialect-specific branches at the
 * call site.
 *
 * libsql supports `RETURNING` on UPSERT (Drizzle's `.returning(...)`
 * pipes through), so the round-trip count stays the same as PG.
 */
import { lt, sql } from "drizzle-orm";
import type { RateLimitStore } from "../interface.js";
import { rateLimitWindows } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteRateLimitStore implements RateLimitStore {
  constructor(private db: DrizzleDb) {}

  async incrementWindow(
    family: string,
    key: string,
    windowMs: number,
    nowIso: string,
  ): Promise<{ count: number; expires_at: string }> {
    const nextExpiresAt = new Date(
      new Date(nowIso).getTime() + windowMs,
    ).toISOString();
    const rows = await this.db
      .insert(rateLimitWindows)
      .values({
        family,
        window_key: key,
        count: 1,
        expires_at: nextExpiresAt,
      })
      .onConflictDoUpdate({
        target: [rateLimitWindows.family, rateLimitWindows.window_key],
        set: {
          count: sql`CASE WHEN ${rateLimitWindows.expires_at} <= ${nowIso} THEN 1 ELSE ${rateLimitWindows.count} + 1 END`,
          expires_at: sql`CASE WHEN ${rateLimitWindows.expires_at} <= ${nowIso} THEN ${nextExpiresAt} ELSE ${rateLimitWindows.expires_at} END`,
        },
      })
      .returning({
        count: rateLimitWindows.count,
        expires_at: rateLimitWindows.expires_at,
      })
      .all();
    const row = rows[0];
    if (!row) {
      throw new Error("rateLimits.incrementWindow: upsert returned no row");
    }
    return { count: row.count, expires_at: row.expires_at };
  }

  async cleanup(nowIso: string): Promise<number> {
    const result = await this.db
      .delete(rateLimitWindows)
      .where(lt(rateLimitWindows.expires_at, nowIso))
      .run();
    return result.rowsAffected;
  }
}
