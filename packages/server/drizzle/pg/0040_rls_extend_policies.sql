-- T-025 Part 2 follow-on: extend per-table RLS policies to the three
-- direct-tenant_id tables that got GRANTs in migration 0037 but no
-- policies. Mechanical extension of Part 1's policy block.
--
-- Tables covered:
--   - inbound_webhooks (tenant_id NULLABLE — single-tenant self-hosts
--     leave it NULL; hosted-mode connectors stamp it from the calling
--     tenant)
--   - connection_oauth_tokens (tenant_id NOT NULL on hosted; legacy
--     single-tenant rows historically stamped NULL)
--   - connection_leased_tokens (same shape as connection_oauth_tokens)
--
-- Policy shape mirrors Part 1: equality on
-- `current_setting('marfa.tenant_id', true)` with a NULL-allowance so
-- single-tenant self-hosts (where tenant_id IS NULL on every row)
-- continue to work transparently when the application-layer never
-- supplies the GUC. Active only when MARFA_RLS_ENFORCE=true gates the
-- middleware that switches the connection role to marfa_app.

ALTER TABLE "inbound_webhooks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "inbound_webhooks_tenant_isolation" ON "inbound_webhooks";
--> statement-breakpoint
CREATE POLICY "inbound_webhooks_tenant_isolation" ON "inbound_webhooks"
  FOR ALL TO "marfa_app"
  USING (tenant_id::text = current_setting('marfa.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

ALTER TABLE "connection_oauth_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "connection_oauth_tokens_tenant_isolation" ON "connection_oauth_tokens";
--> statement-breakpoint
CREATE POLICY "connection_oauth_tokens_tenant_isolation" ON "connection_oauth_tokens"
  FOR ALL TO "marfa_app"
  USING (tenant_id::text = current_setting('marfa.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

ALTER TABLE "connection_leased_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "connection_leased_tokens_tenant_isolation" ON "connection_leased_tokens";
--> statement-breakpoint
CREATE POLICY "connection_leased_tokens_tenant_isolation" ON "connection_leased_tokens"
  FOR ALL TO "marfa_app"
  USING (tenant_id::text = current_setting('marfa.tenant_id', true)
         OR tenant_id IS NULL);
