-- Wave C PR1: per-tenant email suppression list.
-- Composite PK (tenant_id, email). Empty-string sentinel for
-- platform-level / pre-sign-in flows (forgot-password, magic-link).
-- See packages/server/src/storage/interface.ts EmailSuppressionsStore
-- for the application contract.
CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "tenant_id" TEXT NOT NULL DEFAULT '',
  "email" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "source_email_id" TEXT,
  PRIMARY KEY ("tenant_id", "email")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_suppressions_email"
  ON "email_suppressions" ("email");
--> statement-breakpoint
-- T-025 RLS: extend grant + policy to email_suppressions. Empty-string
-- tenant_id is the platform-level row (mirrors blob T-049 convention).
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_suppressions" TO "myme_app";
--> statement-breakpoint
ALTER TABLE "email_suppressions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "email_suppressions_tenant_isolation" ON "email_suppressions";
--> statement-breakpoint
CREATE POLICY "email_suppressions_tenant_isolation" ON "email_suppressions"
  FOR ALL TO "myme_app"
  USING (tenant_id = current_setting('marfa.tenant_id', true)
         OR tenant_id = '');
