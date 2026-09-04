-- The extraction queue is ordered by how long a file has been waiting, and
-- `updated_at` stopped being that. Candidacy is decided by the
-- enrichment-state anti-join, so an item already extracted is reordered
-- rather than re-offered; an item that has NOT been extracted was pushed to
-- the back of the queue by any write that moved its modification time. Once
-- a tag or extension write started moving it, ordinary tagging of a file
-- awaiting extraction delayed it, and repeated tagging delayed it without
-- bound. The queue never fails or errors, so the symptom is a file that
-- simply never gets its contents extracted.
--
-- `created_at` is immovable, which is the whole point: nothing a caller does
-- can change where a candidate sits.
--
-- Re-keyed rather than added beside the old one. The index exists to serve
-- one query's ordering and predicate, and a second copy on a column that
-- query no longer reads is dead weight on every write to items.
DROP INDEX IF EXISTS `idx_items_enrichment_candidates`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_items_enrichment_candidates` ON `items` (`created_at`) WHERE (type = 'core.file' OR type LIKE 'core.file.%') AND state <> 'trashed' AND json_extract(properties, '$.blob_ref') IS NOT NULL;
