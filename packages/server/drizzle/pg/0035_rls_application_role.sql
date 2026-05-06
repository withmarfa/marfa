-- T-025 part 1: Postgres RLS schema scaffold.
--
-- Lands the schema-side RLS scaffolding for hosted-mode multi-tenancy:
-- a new `myme_app` application role, GRANTs on every tenant-scoped
-- table, and per-table RLS policies keyed on a session-scoped tenant
-- context (`current_setting('myme.tenant_id', true)`).
--
-- **What this migration does NOT do.** This migration creates the role
-- and the policies but does not wire the application code to actually
-- connect as `myme_app` and SET the tenant_id. With `RLS_ENFORCE=false`
-- (the default), the application keeps connecting as the owner role and
-- policies have no effect — single-tenant self-hosts are unaffected.
-- The connection-pool wiring (transaction-per-request with `SET LOCAL
-- ROLE myme_app; SET LOCAL myme.tenant_id = '<id>'` after auth) is
-- T-025 part 2 — captured as a follow-on.
--
-- **Tenant matching.** Policies use:
--   tenant_id::text = current_setting('myme.tenant_id', true)
--     OR tenant_id IS NULL
--
-- The NULL clause keeps single-tenant deployments (where every row has
-- `tenant_id IS NULL`) unbroken if RLS is later enabled. Hosted-mode
-- platform-admin connections — which set `myme.tenant_id` to '' — can
-- still see all rows by also matching the NULL clause. The blobs table
-- is special (composite PK requires `tenant_id NOT NULL DEFAULT ''`):
-- its policy uses `tenant_id = ''` for the instance-wide / platform-
-- admin path instead of NULL.
--
-- **Owner role.** The migration assumes the migrating user is the table
-- owner. RLS policies don't apply to the table owner by default — that's
-- exactly the property we want for the existing connection. Switch to
-- `myme_app` only at request time when RLS_ENFORCE=true.

-- ---------------------------------------------------------------------------
-- Role + grants
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myme_app') THEN
    CREATE ROLE "myme_app";
  END IF;
END
$$;
--> statement-breakpoint

-- Default privileges so newly-created tables in the public schema also
-- grant to myme_app. Mostly belt-and-braces — explicit GRANTs below
-- cover today's tables; this catches future tables added without an
-- accompanying RLS migration.
GRANT USAGE ON SCHEMA public TO "myme_app";
--> statement-breakpoint

-- Per-table grants. CRUD on tenant-scoped tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "items",
  "edges",
  "versions",
  "metadata",
  "api_keys",
  "blobs",
  "custom_types",
  "custom_edge_types",
  "outbound_webhooks",
  "outbound_webhook_deliveries",
  "audit_log",
  "event_log",
  "tenants",
  "settings"
TO "myme_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS enable + policies
-- ---------------------------------------------------------------------------

-- items
ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "items_tenant_isolation" ON "items";
--> statement-breakpoint
CREATE POLICY "items_tenant_isolation" ON "items"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- edges
ALTER TABLE "edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "edges_tenant_isolation" ON "edges";
--> statement-breakpoint
CREATE POLICY "edges_tenant_isolation" ON "edges"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- versions
ALTER TABLE "versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "versions_tenant_isolation" ON "versions";
--> statement-breakpoint
CREATE POLICY "versions_tenant_isolation" ON "versions"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- metadata — keyed on item_id, not tenant_id directly. Policy joins via items.
ALTER TABLE "metadata" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "metadata_tenant_isolation" ON "metadata";
--> statement-breakpoint
CREATE POLICY "metadata_tenant_isolation" ON "metadata"
  FOR ALL TO "myme_app"
  USING (EXISTS (
    SELECT 1 FROM "items" WHERE "items".id = "metadata".item_id
      AND ("items".tenant_id::text = current_setting('myme.tenant_id', true)
           OR "items".tenant_id IS NULL)
  ));
--> statement-breakpoint

-- api_keys
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "api_keys_tenant_isolation" ON "api_keys";
--> statement-breakpoint
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- blobs — special: tenant_id NOT NULL DEFAULT '' (composite PK). Empty
-- string is the instance-wide / platform-admin sentinel.
ALTER TABLE "blobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "blobs_tenant_isolation" ON "blobs";
--> statement-breakpoint
CREATE POLICY "blobs_tenant_isolation" ON "blobs"
  FOR ALL TO "myme_app"
  USING (tenant_id = current_setting('myme.tenant_id', true)
         OR tenant_id = '');
--> statement-breakpoint

-- custom_types
ALTER TABLE "custom_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "custom_types_tenant_isolation" ON "custom_types";
--> statement-breakpoint
CREATE POLICY "custom_types_tenant_isolation" ON "custom_types"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- custom_edge_types
ALTER TABLE "custom_edge_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "custom_edge_types_tenant_isolation" ON "custom_edge_types";
--> statement-breakpoint
CREATE POLICY "custom_edge_types_tenant_isolation" ON "custom_edge_types"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- outbound_webhooks
ALTER TABLE "outbound_webhooks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "outbound_webhooks_tenant_isolation" ON "outbound_webhooks";
--> statement-breakpoint
CREATE POLICY "outbound_webhooks_tenant_isolation" ON "outbound_webhooks"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- audit_log (T-041 added tenant_id, nullable; system rows have NULL)
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "audit_log_tenant_isolation" ON "audit_log";
--> statement-breakpoint
CREATE POLICY "audit_log_tenant_isolation" ON "audit_log"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- event_log
ALTER TABLE "event_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "event_log_tenant_isolation" ON "event_log";
--> statement-breakpoint
CREATE POLICY "event_log_tenant_isolation" ON "event_log"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
