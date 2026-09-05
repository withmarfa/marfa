CREATE TABLE `pending_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`code` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_blobs_state_idx` ON `pending_blobs` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `blob_cache` (
	`hash` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`last_read_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `blob_cache_last_read_idx` ON `blob_cache` (`last_read_at`);
