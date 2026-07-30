-- Rename tenant to space, across every surface the database owns.
--
-- One word for the isolated data boundary. The old term stays only in this
-- file and in the migrations before it, which are history and are never
-- edited; nothing after this point carries it.
--
-- No policies to rewrite here: row-level security is Postgres-only. SQLite
-- carries the same tables and the same column, so the renames mirror the
-- Postgres migration exactly.
--
-- `RENAME COLUMN` rewrites references inside triggers, views and indexes
-- automatically on SQLite 3.25 and later, which is why the FTS triggers are
-- not restated. Statement breakpoints separate every statement: libsql's
-- migrator silently drops trailing statements without them.

ALTER TABLE `tenants` RENAME TO `spaces`;
--> statement-breakpoint
ALTER TABLE `tenant_quotas` RENAME TO `space_quotas`;
--> statement-breakpoint
ALTER TABLE `api_keys` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `audit_log` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `blobs` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `bulk_action_jobs` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `connection_leased_tokens` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `connection_oauth_tokens` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `custom_edge_types` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `custom_types` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `edges` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `event_log` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `inbound_webhooks` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `items` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `outbound_webhooks` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `space_quotas` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `tenant_id` TO `space_id`;
--> statement-breakpoint
UPDATE `api_keys` SET role = 'space_admin' WHERE role = 'tenant_admin';
--> statement-breakpoint
-- Index names do not follow their column, so they keep the old word until
-- renamed. SQLite has no ALTER INDEX, so each is dropped and recreated.
DROP INDEX IF EXISTS `idx_api_keys_source_per_tenant`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_api_keys_source_per_space` ON `api_keys` (`space_id`, `source`) WHERE revoked_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_audit_log_tenant_id`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_log_space_id` ON `audit_log` (`space_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_bulk_action_jobs_tenant_id`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bulk_action_jobs_space_id` ON `bulk_action_jobs` (`space_id`);
