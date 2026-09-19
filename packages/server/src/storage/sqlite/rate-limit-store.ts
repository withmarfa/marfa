/**
 * The rate-limit and throttle counter store.
 *
 * One upsert per gated request, and `RETURNING` on the upsert (Drizzle's
 * `.returning(...)` pipes through to libsql) so the new count comes back
 * without a second read.
 *
 * The counters are rows, so every process pointed at one file increments
 * the same row and the cap holds across all of them. SQLite takes one
 * writer at a time, which is what stops two of those increments landing as
 * one.
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

  async incrementWindows(
    family: string,
    keys: string[],
    windowMs: number,
    nowIso: string,
  ): Promise<Map<string, { count: number; expires_at: string }>> {
    const result = new Map<string, { count: number; expires_at: string }>();
    // Deduplicated, because the upsert applies a repeated conflict target
    // twice rather than refusing it — measured, not assumed. No caller
    // passes one today, and this is what keeps that a property of the
    // callers rather than something the cap depends on.
    const unique = [...new Set(keys)];
    if (unique.length === 0) return result;
    const nextExpiresAt = new Date(
      new Date(nowIso).getTime() + windowMs,
    ).toISOString();
    const rows = await this.db
      .insert(rateLimitWindows)
      .values(
        unique.map((key) => ({
          family,
          window_key: key,
          count: 1,
          expires_at: nextExpiresAt,
        })),
      )
      .onConflictDoUpdate({
        target: [rateLimitWindows.family, rateLimitWindows.window_key],
        set: {
          count: sql`CASE WHEN ${rateLimitWindows.expires_at} <= ${nowIso} THEN 1 ELSE ${rateLimitWindows.count} + 1 END`,
          expires_at: sql`CASE WHEN ${rateLimitWindows.expires_at} <= ${nowIso} THEN ${nextExpiresAt} ELSE ${rateLimitWindows.expires_at} END`,
        },
      })
      .returning({
        key: rateLimitWindows.window_key,
        count: rateLimitWindows.count,
        expires_at: rateLimitWindows.expires_at,
      })
      .all();
    for (const row of rows) {
      result.set(row.key, { count: row.count, expires_at: row.expires_at });
    }
    return result;
  }

  async cleanup(nowIso: string): Promise<number> {
    const result = await this.db
      .delete(rateLimitWindows)
      .where(lt(rateLimitWindows.expires_at, nowIso))
      .run();
    return result.rowsAffected;
  }
}
