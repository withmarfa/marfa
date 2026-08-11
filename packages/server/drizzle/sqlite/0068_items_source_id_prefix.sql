-- A folder is a path prefix, not a type, so "everything under Notes/" is a
-- prefix scan over `source_id` and there was no index that could serve one.
-- The natural-key unique index leads with the space and `source`, so it
-- answers an exact-match lookup and nothing else.
--
-- `COLLATE NOCASE` is the counterpart to the Postgres side's
-- `text_pattern_ops`, and for the same underlying reason: an index can only
-- serve a prefix match when its collation is the one the match uses. SQLite's
-- LIKE is case-insensitive over ASCII by default, so a BINARY-collated index
-- is the wrong ordering and the planner silently declines the range. Measured
-- on 40k rows: with a plain index the plan is
-- `SEARCH items USING INDEX ... (space_id=?)`, scanning the whole space and
-- filtering; with NOCASE it becomes
-- `(space_id=? AND source_id>? AND source_id<?)`, a real prefix range.
--
-- This does not change what the query matches. It makes the index agree with
-- the semantics LIKE already had on this dialect.
--
-- Partial on NOT NULL for the same reason as the Postgres side — only rows
-- carrying a path are ever prefix-matched.
CREATE INDEX IF NOT EXISTS "idx_items_source_id_prefix"
  ON "items" ("space_id", "source_id" COLLATE NOCASE)
  WHERE "source_id" IS NOT NULL;
