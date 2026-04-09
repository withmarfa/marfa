CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`key_hash` text NOT NULL,
	`label` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`type_permissions` text DEFAULT '{"*":"write"}' NOT NULL,
	`extension_permissions` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`key_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`details` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_timestamp` ON `audit_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_resource_type` ON `audit_log` (`resource_type`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`storage_path` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `custom_types` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`schema` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`item_id` text NOT NULL,
	`tenant_id` text,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_event_log_created_at` ON `event_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`type` text NOT NULL,
	`state` text DEFAULT 'new' NOT NULL,
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
CREATE INDEX `idx_items_type` ON `items` (`type`);--> statement-breakpoint
CREATE INDEX `idx_items_state` ON `items` (`state`);--> statement-breakpoint
CREATE INDEX `idx_items_thread_id` ON `items` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_items_parent_id` ON `items` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_items_created_at` ON `items` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_items_timestamp` ON `items` (`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_items_source_dedup` ON `items` (`source`,`source_id`) WHERE source IS NOT NULL;--> statement-breakpoint
CREATE TABLE `metadata` (
	`item_id` text PRIMARY KEY NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`about` text DEFAULT '[]' NOT NULL,
	`extensions` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_challenge` text NOT NULL,
	`code_challenge_method` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_codes_code_hash_unique` ON `oauth_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_grants_client_id` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_type` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_token_hash_unique` ON `oauth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_grant_id` ON `oauth_tokens` (`grant_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_token_hash` ON `oauth_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_provider` ON `users` (`provider`,`provider_id`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`version` integer NOT NULL,
	`properties` text NOT NULL,
	`created_at` text NOT NULL,
	`device_id` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_versions_item_id` ON `versions` (`item_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event` text NOT NULL,
	`status_code` integer,
	`attempt` integer NOT NULL,
	`success` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`next_attempt_at` text,
	`payload` text,
	`webhook_url` text,
	`webhook_secret` text,
	`max_attempts` integer DEFAULT 4 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_webhook_id` ON `webhook_deliveries` (`webhook_id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`type_filter` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
