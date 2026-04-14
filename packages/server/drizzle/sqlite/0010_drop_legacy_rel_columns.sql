-- Wave 2 PR 4: drop legacy relationship columns now that edges are first-
-- class. SQLite supports DROP COLUMN directly since 3.35, which better-
-- sqlite3 bundles. Run only after 0009 (the edge backfill sentinel).

DROP INDEX IF EXISTS `idx_items_parent_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_items_thread_id`;--> statement-breakpoint

ALTER TABLE `items` DROP COLUMN `parent_id`;--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `thread_id`;--> statement-breakpoint

ALTER TABLE `metadata` DROP COLUMN `about`;
