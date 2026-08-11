-- The enrichment candidate query runs every thirty seconds forever, and on
-- an instance whose corpus is already extracted it must cost almost nothing.
-- Against the shipped schema it was a full scan plus a temporary sort. The
-- claim recorded when `enrichment_state` was created — that the PK covered
-- the candidate query — was true of the anti-join side only; the items side
-- had no index for either the filter or the `updated_at` ordering.
--
-- Partial rather than full: only file items with a blob are ever
-- candidates. The predicate must match the query's WHERE clauses as
-- literals — SQLite only uses a partial index when the query provably
-- implies its predicate, and a bound parameter can never be proven.
CREATE INDEX IF NOT EXISTS "idx_items_enrichment_candidates" ON "items" ("updated_at")
  WHERE ("type" = 'core.file' OR "type" LIKE 'core.file.%')
    AND "state" <> 'trashed'
    AND json_extract("properties", '$.blob_ref') IS NOT NULL;
--> statement-breakpoint
-- The configuration a skip was decided under. A skip is only terminal
-- relative to the settings that produced it: raise the size ceiling or
-- enable image reading and the row deserves another look. The sweeper
-- stamps its current configuration signature on every row it writes, and
-- the candidate query re-offers skipped rows whose stamp differs — one
-- re-evaluation per configuration change, then parked again. Rows from
-- before this column exist re-offer once and get stamped.
ALTER TABLE "enrichment_state" ADD COLUMN "config_signature" TEXT;
