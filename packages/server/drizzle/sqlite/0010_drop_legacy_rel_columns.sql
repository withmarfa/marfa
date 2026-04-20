-- Wave 2 PR 4: drop legacy relationship columns now that edges are first-
-- class. Run only after 0009 (the edge backfill sentinel).
--
-- SQLite cannot `DROP COLUMN thread_id` directly because 0001 declared a
-- FOREIGN KEY on items referencing threads(id) via that column. sqlite blocks
-- column drops that are part of a constraint with
-- `error in table items after drop column: unknown column "thread_id" in
-- foreign key definition`. The fix is the standard table-rebuild dance:
-- PRAGMA foreign_keys=OFF, create a new items table with the desired shape
-- (no parent_id, thread_id, or FK), copy rows across, swap, recreate indexes,
-- re-enable FKs. Same pattern 0001 used.
--
-- metadata.about has no constraint attached, so a native DROP COLUMN works.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_items_parent_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_items_thread_id`;--> statement-breakpoint
CREATE TABLE `__new_items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`type` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`library` integer DEFAULT 0 NOT NULL,
	`properties` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`timestamp` text NOT NULL,
	`source` text,
	`source_id` text,
	`origin` text,
	`version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer,
	`device` text,
	`capture_latitude` real,
	`capture_longitude` real
);
--> statement-breakpoint
INSERT INTO `__new_items`("id", "tenant_id", "type", "state", "library", "properties", "created_at", "updated_at", "timestamp", "source", "source_id", "origin", "version", "schema_version", "device", "capture_latitude", "capture_longitude") SELECT "id", "tenant_id", "type", "state", "library", "properties", "created_at", "updated_at", "timestamp", "source", "source_id", "origin", "version", "schema_version", "device", "capture_latitude", "capture_longitude" FROM `items`;--> statement-breakpoint
DROP TABLE `items`;--> statement-breakpoint
ALTER TABLE `__new_items` RENAME TO `items`;--> statement-breakpoint
CREATE INDEX `idx_items_type` ON `items` (`type`);--> statement-breakpoint
CREATE INDEX `idx_items_state` ON `items` (`state`);--> statement-breakpoint
CREATE INDEX `idx_items_created_at` ON `items` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_items_timestamp` ON `items` (`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_items_source_dedup` ON `items` (`source`,`source_id`) WHERE source IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `metadata` DROP COLUMN `about`;
