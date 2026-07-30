-- Rename tenant to space, across every surface the database owns.
--
-- One word for the isolated data boundary. The old term stays only in this
-- file and in the migrations that precede it, which are history and are never
-- edited; nothing after this point carries it.
--
-- Column renames keep their policies and indexes attached, because Postgres
-- stores those against column identity rather than name. The GUC does not
-- follow: `current_setting('marfa.tenant_id')` is a string literal inside each
-- policy expression, so every policy is dropped and recreated against
-- `marfa.space_id`. That rewrite is the risky part of this migration and the
-- reason each policy below is restated in full rather than patched.

-- The two tables named for the old word.
ALTER TABLE "tenants" RENAME TO "spaces";
ALTER TABLE "tenant_quotas" RENAME TO "space_quotas";

-- The column, everywhere it appears. `space_quotas` is listed under its
-- new name because the table rename above has already happened.
ALTER TABLE "api_keys" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "audit_log" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "blobs" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "bulk_action_jobs" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "connection_leased_tokens" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "connection_oauth_tokens" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "custom_edge_types" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "custom_types" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "edges" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "event_log" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "inbound_webhooks" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "items" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "outbound_webhooks" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "space_quotas" RENAME COLUMN "tenant_id" TO "space_id";
ALTER TABLE "users" RENAME COLUMN "tenant_id" TO "space_id";

-- The stored role value. `tenant_admin` is data, not an identifier, so no
-- schema change reaches it.
UPDATE "api_keys" SET role = 'space_admin' WHERE role = 'tenant_admin';

-- Every policy, dropped and recreated against the renamed column and the
-- renamed GUC. Taken from the live definitions rather than retyped, so a
-- policy cannot quietly lose a clause in transcription.

DROP POLICY IF EXISTS api_keys_tenant_isolation ON public.api_keys;
CREATE POLICY api_keys_space_isolation ON public.api_keys TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS audit_log_tenant_isolation ON public.audit_log;
CREATE POLICY audit_log_space_isolation ON public.audit_log TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS auth_user_self ON public.auth_user;
CREATE POLICY auth_user_self ON public.auth_user FOR SELECT TO marfa_app USING ((id IN ( SELECT users.auth_user_id
   FROM public.users
  WHERE (users.space_id = current_setting('marfa.space_id'::text, true)))));

DROP POLICY IF EXISTS blobs_tenant_isolation ON public.blobs;
CREATE POLICY blobs_space_isolation ON public.blobs TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id = ''::text)));

DROP POLICY IF EXISTS bulk_action_jobs_tenant_isolation ON public.bulk_action_jobs;
CREATE POLICY bulk_action_jobs_space_isolation ON public.bulk_action_jobs TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS connection_leased_tokens_tenant_isolation ON public.connection_leased_tokens;
CREATE POLICY connection_leased_tokens_space_isolation ON public.connection_leased_tokens TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS connection_oauth_tokens_tenant_isolation ON public.connection_oauth_tokens;
CREATE POLICY connection_oauth_tokens_space_isolation ON public.connection_oauth_tokens TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS custom_edge_types_tenant_isolation ON public.custom_edge_types;
CREATE POLICY custom_edge_types_space_isolation ON public.custom_edge_types TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id = ''::text)));

DROP POLICY IF EXISTS custom_types_tenant_isolation ON public.custom_types;
CREATE POLICY custom_types_space_isolation ON public.custom_types TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id = ''::text)));

DROP POLICY IF EXISTS edges_tenant_isolation ON public.edges;
CREATE POLICY edges_space_isolation ON public.edges TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS event_log_tenant_isolation ON public.event_log;
CREATE POLICY event_log_space_isolation ON public.event_log TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS inbound_webhook_events_tenant_isolation ON public.inbound_webhook_events;
CREATE POLICY inbound_webhook_events_space_isolation ON public.inbound_webhook_events TO marfa_app USING ((EXISTS ( SELECT 1
   FROM public.inbound_webhooks w
  WHERE ((w.id = inbound_webhook_events.inbound_webhook_id) AND ((w.space_id = current_setting('marfa.space_id'::text, true)) OR (w.space_id IS NULL))))));

DROP POLICY IF EXISTS inbound_webhooks_tenant_isolation ON public.inbound_webhooks;
CREATE POLICY inbound_webhooks_space_isolation ON public.inbound_webhooks TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS items_tenant_isolation ON public.items;
CREATE POLICY items_space_isolation ON public.items TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS metadata_tenant_isolation ON public.metadata;
CREATE POLICY metadata_space_isolation ON public.metadata TO marfa_app USING ((EXISTS ( SELECT 1
   FROM public.items
  WHERE ((items.id = metadata.item_id) AND ((items.space_id = current_setting('marfa.space_id'::text, true)) OR (items.space_id IS NULL))))));

DROP POLICY IF EXISTS outbound_webhook_deliveries_tenant_isolation ON public.outbound_webhook_deliveries;
CREATE POLICY outbound_webhook_deliveries_space_isolation ON public.outbound_webhook_deliveries TO marfa_app USING ((EXISTS ( SELECT 1
   FROM public.outbound_webhooks w
  WHERE ((w.id = outbound_webhook_deliveries.webhook_id) AND ((w.space_id = current_setting('marfa.space_id'::text, true)) OR (w.space_id IS NULL))))));

DROP POLICY IF EXISTS outbound_webhooks_tenant_isolation ON public.outbound_webhooks;
CREATE POLICY outbound_webhooks_space_isolation ON public.outbound_webhooks TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS tenant_quotas_tenant_isolation ON public.space_quotas;
CREATE POLICY space_quotas_space_isolation ON public.space_quotas TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS tenants_self_isolation ON public.spaces;
CREATE POLICY spaces_self_isolation ON public.spaces TO marfa_app USING ((id = current_setting('marfa.space_id'::text, true)));

DROP POLICY IF EXISTS users_tenant_isolation ON public.users;
CREATE POLICY users_space_isolation ON public.users TO marfa_app USING (((space_id = current_setting('marfa.space_id'::text, true)) OR (space_id IS NULL)));

DROP POLICY IF EXISTS versions_tenant_isolation ON public.versions;
CREATE POLICY versions_space_isolation ON public.versions TO marfa_app USING ((EXISTS ( SELECT 1
   FROM public.items
  WHERE ((items.id = versions.item_id) AND ((items.space_id = current_setting('marfa.space_id'::text, true)) OR (items.space_id IS NULL))))));


-- Constraint and index names do not follow their table or column, so they
-- keep the old word until renamed explicitly. Left alone they would ship
-- into every fresh database and into the generated bootstrap schema, which
-- is active code rather than history.

ALTER TABLE "blobs" RENAME CONSTRAINT "blobs_tenant_id_hash_pk" TO "blobs_space_id_hash_pk";
ALTER TABLE "custom_edge_types" RENAME CONSTRAINT "custom_edge_types_tenant_id_id_pk" TO "custom_edge_types_space_id_id_pk";
ALTER TABLE "custom_types" RENAME CONSTRAINT "custom_types_tenant_id_id_pk" TO "custom_types_space_id_id_pk";
ALTER TABLE "space_quotas" RENAME CONSTRAINT "tenant_quotas_pkey" TO "space_quotas_pkey";
ALTER TABLE "spaces" RENAME CONSTRAINT "tenants_pkey" TO "spaces_pkey";
ALTER TABLE "users" RENAME CONSTRAINT "users_tenant_id_tenants_id_fk" TO "users_space_id_spaces_id_fk";

ALTER INDEX "idx_api_keys_source_per_tenant" RENAME TO "idx_api_keys_source_per_space";
ALTER INDEX "idx_audit_log_tenant_id" RENAME TO "idx_audit_log_space_id";
ALTER INDEX "idx_bulk_action_jobs_tenant_id" RENAME TO "idx_bulk_action_jobs_space_id";
