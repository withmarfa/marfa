-- A folder is a path prefix, not a type, so "everything under Notes/" is a
-- prefix scan over `source_id` and there was no index that could serve one.
-- The natural-key unique index leads with the space and `source`, so it
-- answers an exact-match lookup and nothing else; a prefix query fell back
-- to a sequential scan over every item in the space.
--
-- `text_pattern_ops` rather than the default operator class: a btree built
-- under a non-C collation cannot serve LIKE at all, because the collation's
-- sort order is not the byte order the pattern match walks. That is the
-- whole reason this index needs its own opclass rather than riding the
-- existing one.
--
-- Composite on (space_id, source_id) because the query always carries a
-- space: the equality on the leading column narrows to the space, and the
-- prefix range is then a contiguous run within it. Partial on NOT NULL
-- because only rows a client stored a path for are ever prefix-matched,
-- which keeps the index to the synced corpus rather than every item.
CREATE INDEX IF NOT EXISTS "idx_items_source_id_prefix"
  ON "items" ("space_id", "source_id" text_pattern_ops)
  WHERE "source_id" IS NOT NULL;
