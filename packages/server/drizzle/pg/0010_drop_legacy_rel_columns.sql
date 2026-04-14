-- Wave 2 PR 4: drop legacy relationship columns now that edges are first-
-- class. Run only after 0009 (the edge backfill sentinel) has applied.

DROP INDEX IF EXISTS idx_items_parent_id;--> statement-breakpoint
DROP INDEX IF EXISTS idx_items_thread_id;--> statement-breakpoint

ALTER TABLE items DROP COLUMN IF EXISTS parent_id;--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS thread_id;--> statement-breakpoint

ALTER TABLE metadata DROP COLUMN IF EXISTS about;
