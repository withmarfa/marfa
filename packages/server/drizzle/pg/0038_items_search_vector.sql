-- T-015: materialised tsvector + GIN index on items for FTS dialect
-- parity. Replaces the at-query-time `to_tsvector(...)` sequential scan
-- the search store ran on every request. The column is populated by
-- `PgSearchStore.index/remove` at item write time using the same field
-- set as SQLite's items_fts table — `extractSearchableText` in the
-- shared `storage/search-text.ts` helper is the single source of truth
-- for "what text contributes to FTS for this item".
--
-- The column is NULLABLE: rows existing pre-T-015 carry NULL until the
-- backfill (next migration) runs. The search query treats NULL the same
-- as no rows, so a partial backfill leaves only un-backfilled rows
-- invisible to search — never produces wrong results.

ALTER TABLE items ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

CREATE INDEX IF NOT EXISTS idx_items_search_vector
  ON items USING GIN(search_vector);

-- Grant on the new column to marfa_app (the RLS application role from
-- T-025). The role already has SELECT/INSERT/UPDATE/DELETE on items,
-- but ALTER TABLE ADD COLUMN inherits those grants in PG only when the
-- role-level grant covered all columns at creation time. Belt-and-
-- braces — re-run the GRANT explicitly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marfa_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON items TO marfa_app;
  END IF;
END $$;
