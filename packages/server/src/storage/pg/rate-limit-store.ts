/**
 * T-026: Postgres rate-limit / throttle counter store.
 *
 * Atomic increment + window-rollover via a single
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` round-trip. The
 * conflict path computes the new count + new expiry from the existing
 * row's state:
 *
 *   - If the existing row's `expires_at` is in the past, the window has
 *     rolled over: count resets to 1 and `expires_at` is pushed to
 *     `nowIso + windowMs`.
 *   - Otherwise the window is still open: count increments by 1 and
 *     `expires_at` stays put.
 *
 * Postgres serialises concurrent INSERT/UPDATE on the same row via
 * row-level locking, so two instances racing the same key cannot both
 * observe `count == 1` inside one window. The `RETURNING` clause sends
 * back the post-update values in the same round-trip.
 *
 * `cleanup()` is the matching GC — used by the
 * `RateLimitWindowCleaner` retention sweep. Expired rows aren't a
 * correctness risk (the upsert path overwrites them transparently);
 * the GC just keeps the table from growing unboundedly.
 */
import { lt, sql } from "drizzle-orm";
import type { RateLimitStore } from "../interface.js";
import { rateLimitWindows } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgRateLimitStore implements RateLimitStore {
  constructor(private db: PgDb) {}

  async incrementWindow(
    family: string,
    key: string,
    windowMs: number,
    nowIso: string,
  ): Promise<{ count: number; expires_at: string }> {
    const nextExpiresAt = new Date(
      new Date(nowIso).getTime() + windowMs,
    ).toISOString();
    // The ON CONFLICT DO UPDATE branch reads the EXISTING row's
    // expires_at via `rate_limit_windows.expires_at` and compares it
    // against `nowIso` directly inside the SQL — no read-modify-write
    // race on the application side. Lexicographic comparison on ISO
    // strings is correct so long as all writers use UTC ISO, which
    // we do (`new Date().toISOString()` everywhere).
    const [row] = await this.db
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
      });
    if (!row) {
      // Unreachable in practice — the upsert always writes one row —
      // but type-safety insists on a fallback.
      throw new Error("rateLimits.incrementWindow: upsert returned no row");
    }
    return { count: row.count, expires_at: row.expires_at };
  }

  async cleanup(nowIso: string): Promise<number> {
    const rows = await this.db
      .delete(rateLimitWindows)
      .where(lt(rateLimitWindows.expires_at, nowIso))
      .returning({ family: rateLimitWindows.family });
    return rows.length;
  }
}
