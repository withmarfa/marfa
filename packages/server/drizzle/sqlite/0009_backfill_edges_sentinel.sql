-- Sentinel migration for the app-layer edge backfill.
--
-- The actual backfill (items.parent_id → parent-of edges, items.thread_id →
-- in-thread edges with position, metadata.about → about edges) runs as a
-- TypeScript script after Drizzle applies the 0009 marker. SQLite has no
-- built-in UUID function so the backfill stays in app space.
--
-- The migrate CLI auto-invokes the script; re-running is idempotent.
SELECT 1;
