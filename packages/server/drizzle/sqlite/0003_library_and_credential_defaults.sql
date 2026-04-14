ALTER TABLE `items` ADD COLUMN `library` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `api_keys` ADD COLUMN `source` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `api_keys` ADD COLUMN `default_origin` text NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `api_keys` ADD COLUMN `default_library` integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_api_keys_source_per_tenant`
  ON `api_keys` (`tenant_id`, `source`) WHERE revoked_at IS NULL;
