CREATE TABLE `server_items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`space_id` text,
	`updated_at` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `server_items_type_idx` ON `server_items` (`type`);--> statement-breakpoint
CREATE INDEX `server_items_updated_at_idx` ON `server_items` (`updated_at`);--> statement-breakpoint
CREATE TABLE `server_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`edge_type` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `server_edges_source_idx` ON `server_edges` (`source_id`);--> statement-breakpoint
CREATE INDEX `server_edges_target_idx` ON `server_edges` (`target_id`);--> statement-breakpoint
CREATE INDEX `server_edges_updated_at_idx` ON `server_edges` (`updated_at`);--> statement-breakpoint
CREATE TABLE `server_metadata` (
	`item_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`payload` text NOT NULL,
	`base_version` integer,
	`idempotency_key` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`blocked_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_id_unique` ON `outbox` (`id`);--> statement-breakpoint
CREATE INDEX `outbox_state_seq_idx` ON `outbox` (`state`,`seq`);--> statement-breakpoint
CREATE INDEX `outbox_target_idx` ON `outbox` (`target_id`,`seq`);--> statement-breakpoint
CREATE TABLE `dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`payload` text NOT NULL,
	`reason` text NOT NULL,
	`code` text,
	`message` text NOT NULL,
	`http_status` integer,
	`failed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dead_letters_seq_idx` ON `dead_letters` (`seq`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`origin` text NOT NULL,
	`space_id` text NOT NULL,
	`account_id` text NOT NULL,
	`cursor` text,
	`hydrated_at` text,
	`last_drained_at` text,
	PRIMARY KEY(`origin`, `space_id`, `account_id`)
);
