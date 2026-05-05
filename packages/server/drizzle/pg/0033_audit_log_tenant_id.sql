-- T-041: tenant-scoping the audit log.
-- See sqlite/0031_audit_log_tenant_id.sql for design notes.

ALTER TABLE audit_log ADD COLUMN tenant_id TEXT;
--> statement-breakpoint
CREATE INDEX idx_audit_log_tenant_id ON audit_log(tenant_id);
