-- Item content moves to SQLite's native JSONB storage: the column becomes a
-- blob holding the binary JSON encoding, written via jsonb() and read back
-- through json(). json_extract and its siblings read the blob directly with
-- no per-row text parse. In-place updates must use jsonb_set from here on:
-- json_set returns text and would silently revert a row to the old encoding.
--
-- SQLite cannot ALTER COLUMN TYPE, so this is the standard table-rebuild
-- dance from 0001 and 0010: PRAGMA foreign_keys=OFF, rebuild with the new
-- shape, copy rows through jsonb(), swap, recreate the indexes, re-enable
-- FKs. The FTS table is untouched: items_fts stores its own copy of the
-- searchable text and is maintained by application code.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_items` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text,
	`type` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`properties` blob NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`timestamp` text NOT NULL,
	`source` text,
	`source_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer,
	`device` text,
	`capture_latitude` real,
	`capture_longitude` real,
	`tier` text DEFAULT 'library' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_items`("id", "space_id", "type", "state", "properties", "created_at", "updated_at", "timestamp", "source", "source_id", "version", "schema_version", "device", "capture_latitude", "capture_longitude", "tier") SELECT "id", "space_id", "type", "state", jsonb("properties"), "created_at", "updated_at", "timestamp", "source", "source_id", "version", "schema_version", "device", "capture_latitude", "capture_longitude", "tier" FROM `items`;--> statement-breakpoint
DROP TABLE `items`;--> statement-breakpoint
ALTER TABLE `__new_items` RENAME TO `items`;--> statement-breakpoint
CREATE INDEX `idx_items_type` ON `items` (`type`);--> statement-breakpoint
CREATE INDEX `idx_items_state` ON `items` (`state`);--> statement-breakpoint
CREATE INDEX `idx_items_created_at` ON `items` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_items_timestamp` ON `items` (`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_items_source_dedup` ON `items` (`source`,`source_id`) WHERE source IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=ON;
