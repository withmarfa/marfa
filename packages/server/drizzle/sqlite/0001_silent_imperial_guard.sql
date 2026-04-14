PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`type` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`properties` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`timestamp` text NOT NULL,
	`source` text,
	`source_id` text,
	`origin` text,
	`version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer,
	`device_id` text,
	`parent_id` text,
	`thread_id` text,
	`capture_latitude` real,
	`capture_longitude` real,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_items`("id", "tenant_id", "type", "state", "properties", "created_at", "updated_at", "timestamp", "source", "source_id", "origin", "version", "schema_version", "device_id", "parent_id", "thread_id", "capture_latitude", "capture_longitude") SELECT "id", "tenant_id", "type", "state", "properties", "created_at", "updated_at", "timestamp", "source", "source_id", "origin", "version", "schema_version", "device_id", "parent_id", "thread_id", "capture_latitude", "capture_longitude" FROM `items`;--> statement-breakpoint
DROP TABLE `items`;--> statement-breakpoint
ALTER TABLE `__new_items` RENAME TO `items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_items_type` ON `items` (`type`);--> statement-breakpoint
CREATE INDEX `idx_items_state` ON `items` (`state`);--> statement-breakpoint
CREATE INDEX `idx_items_thread_id` ON `items` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_items_parent_id` ON `items` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_items_created_at` ON `items` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_items_timestamp` ON `items` (`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_items_source_dedup` ON `items` (`source`,`source_id`) WHERE source IS NOT NULL;