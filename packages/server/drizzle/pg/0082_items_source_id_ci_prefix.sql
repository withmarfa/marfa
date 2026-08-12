-- The text operators become case-insensitive on Postgres, matching what
-- SQLite has always done, so the same filter answers the same rows on
-- both dialects. The predicate becomes LOWER(source_id) LIKE, and a
-- btree on the raw column cannot serve that: the index has to be built
-- over the same expression the predicate compares.
--
-- The previous index (idx_items_source_id_prefix, on the raw column) is
-- deliberately NOT dropped here. Migrations run before the new build
-- rolls, so for the length of the deploy window the old build's
-- case-sensitive predicate is still serving traffic, and dropping its
-- index in the same step would silently turn every folder query into a
-- sequential scan for that window. A later cleanup migration drops it
-- once no serving build uses the old predicate.
--
-- Same shape as its predecessor otherwise: text_pattern_ops because the
-- pattern match walks byte order, composite on (space_id, expression)
-- because the query always carries a space, partial on NOT NULL to keep
-- the index to the synced corpus.
CREATE INDEX IF NOT EXISTS "idx_items_source_id_ci_prefix"
  ON "items" ("space_id", LOWER("source_id") text_pattern_ops)
  WHERE "source_id" IS NOT NULL;
