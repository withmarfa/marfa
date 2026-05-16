-- T-131: drop the homegrown OAuth-protocol tables. Their replacements
-- (`auth_oauth_client`, `auth_oauth_access_token`, `auth_oauth_refresh_token`,
-- `auth_oauth_consent`) landed in migration 0047 and are owned by the
-- @better-auth/oauth-provider plugin.
--
-- Pre-launch positioning means no real users to migrate; staging OAuth
-- state was cleared and re-created via the new flow. Per the project's
-- "no legacy carry-over" principle, no dual surface, no data preservation.
--
-- The `oauth_device_codes` table is intentionally KEPT — it's the Myme-
-- owned state machine for the device-flow surfaces (`/auth/device*`)
-- which the plugin doesn't replace. Its `client_id` FK to `oauth_clients`
-- is replaced by an application-enforced reference to
-- `auth_oauth_client.client_id` (matched by string, not FK constraint),
-- consistent with how the plugin's own cross-table references work.

-- Drop dependent FK first: the device-codes table previously FK'd to
-- oauth_clients.id. SQLite supports DROP COLUMN starting 3.35, but
-- ALTER TABLE on FK requires recreation. Simpler: just drop the dependent
-- tables, then recreate the device-codes FK as a plain column.
DROP TABLE IF EXISTS `oauth_tokens`;
--> statement-breakpoint
DROP TABLE IF EXISTS `oauth_codes`;
--> statement-breakpoint
-- Rebuild oauth_device_codes WITHOUT the FK to oauth_clients (which is
-- about to be dropped). SQLite has no way to drop an FK in place; the
-- pattern is "create new table, copy rows, drop old, rename new".
CREATE TABLE `__new_oauth_device_codes` (
  `id` text PRIMARY KEY NOT NULL,
  `device_code_hash` text NOT NULL,
  `user_code` text NOT NULL,
  `client_id` text NOT NULL,
  `scope` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `connection_item_id` text,
  `expires_at` text NOT NULL,
  `interval_seconds` integer DEFAULT 5 NOT NULL,
  `last_polled_at` text,
  `approved_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`connection_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_oauth_device_codes` SELECT
  `id`, `device_code_hash`, `user_code`, `client_id`, `scope`, `status`,
  `connection_item_id`, `expires_at`, `interval_seconds`, `last_polled_at`,
  `approved_at`, `created_at`
FROM `oauth_device_codes`;
--> statement-breakpoint
DROP TABLE `oauth_device_codes`;
--> statement-breakpoint
ALTER TABLE `__new_oauth_device_codes` RENAME TO `oauth_device_codes`;
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_device_codes_device_code_hash_unique` ON `oauth_device_codes` (`device_code_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_device_codes_user_code_unique` ON `oauth_device_codes` (`user_code`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_device_codes_user_code` ON `oauth_device_codes` (`user_code`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_device_codes_status` ON `oauth_device_codes` (`status`);
--> statement-breakpoint
-- Now drop the parent clients table.
DROP TABLE IF EXISTS `oauth_clients`;
