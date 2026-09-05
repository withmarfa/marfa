CREATE TABLE `cached_types` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`cached_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `outbox` ADD `schema_refreshed_at` text;
