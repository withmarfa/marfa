-- Scope integration provenance dedup to the space.
--
-- `idx_items_source_dedup` was UNIQUE on (source, source_id) across the
-- whole instance. Provenance identity is per space: two spaces syncing
-- the same integration against the same upstream record are two separate
-- corpora, and the second one's write failed on a row it cannot see, does
-- not own, and has no way to reach.
--
-- COALESCE rather than a plain (space_id, source, source_id) composite:
-- `space_id` is nullable, and NULL is never equal to NULL in a unique
-- index, so a plain composite would stop deduping the null-space bucket
-- entirely -- which is every row on a single-space self-host, the exact
-- deployment least able to notice. Postgres 15's NULLS NOT DISTINCT says
-- the same thing and has no SQLite equivalent, so the expression is what
-- keeps one definition across both dialects.
--
-- The index name is deliberately kept. The storage layer's violation
-- traps match on it as a string to tell a provenance collision from a
-- primary-key collision, so renaming it would silently turn a clean 409
-- into an opaque 500.
--
-- This only loosens: every tuple unique under the old index is unique
-- under the new one, so no dedup pass is needed and the build cannot fail
-- on existing rows.
DROP INDEX IF EXISTS "idx_items_source_dedup";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_items_source_dedup"
  ON "items" (COALESCE("space_id", ''), "source", "source_id")
  WHERE source IS NOT NULL;
