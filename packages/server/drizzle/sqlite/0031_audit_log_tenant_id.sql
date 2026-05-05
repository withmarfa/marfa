-- T-041: tenant-scoping the audit log.
--
-- Adds a nullable `tenant_id` column to `audit_log` so reads can filter
-- by the calling api key's tenant. Index on `tenant_id` because every
-- hosted-mode `GET /audit` issues a `WHERE tenant_id = ?` filter.
--
-- Existing rows stay null (system-initiated audits / pre-T-041 writes).
-- Bootstrap-admin keys without a tenant_id continue to read every row
-- (matching the `ItemStore.list` admit-all-when-tenantless pattern).

ALTER TABLE `audit_log` ADD COLUMN `tenant_id` text;
--> statement-breakpoint
CREATE INDEX `idx_audit_log_tenant_id` ON `audit_log` (`tenant_id`);
