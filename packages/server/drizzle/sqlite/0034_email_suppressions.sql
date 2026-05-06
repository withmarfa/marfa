-- Wave C PR1: per-tenant email suppression list (SQLite peer of pg/0041).
-- Composite PK (tenant_id, email). Empty-string sentinel for
-- platform-level / pre-sign-in flows. SQLite has no RLS layer — the
-- application enforces tenant scoping via `(tenant_id, email)` lookups.
CREATE TABLE IF NOT EXISTS `email_suppressions` (
  `tenant_id` text DEFAULT '' NOT NULL,
  `email` text NOT NULL,
  `reason` text NOT NULL,
  `created_at` text NOT NULL,
  `source_email_id` text,
  PRIMARY KEY(`tenant_id`, `email`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_email_suppressions_email`
  ON `email_suppressions` (`email`);
