-- Close the RLS gap on four marfa_app-granted tables that carry tenant
-- data but never got a policy. They were granted CRUD to marfa_app (in
-- 0035 / 0037) so the role can satisfy real request paths, but with RLS
-- disabled those grants meant an unscoped query as marfa_app could read
-- across tenants — the application-layer fence was the only protection.
-- This brings them under the same equality-on-`current_setting` policy
-- shape as the rest of the tenant-scoped tables, so RLS is the
-- defence-in-depth backstop here too.
--
--   - users — direct NOT NULL tenant_id.
--   - tenant_quotas — tenant_id is the PK.
--   - outbound_webhook_deliveries — no tenant_id; joins to its parent
--     outbound_webhooks via webhook_id.
--   - inbound_webhook_events — no tenant_id; joins to its parent
--     inbound_webhooks via inbound_webhook_id.
--
-- Same NULL-allowance as the existing policies: single-tenant self-hosts
-- (every row tenant_id IS NULL) and the operator path (GUC '') keep
-- working transparently. The two child tables defer the NULL/'' allowance
-- to the parent's own tenant_id, so the join predicate matches their
-- parent policy exactly.
--
-- **No FORCE — deliberate, load-bearing.** These tables use plain ENABLE
-- ROW LEVEL SECURITY, never FORCE. The table-owner connection must stay
-- RLS-EXEMPT. Two owner-connection code paths write/read `users` with no
-- `marfa.tenant_id` GUC set:
--   1. The Better Auth sign-up provisioning hook
--      (auth/instance.ts databaseHooks.user.create.after) inserts the new
--      `users` row on the unwrapped owner connection (Better Auth manages
--      its own connection context outside the data-plane RLS middleware).
--   2. The bearer path resolves an OAuth principal's user row via
--      `users.getByAuthUserId`, which runs before the per-request RLS
--      transaction wrapper is installed — i.e. on the owner connection.
-- A FORCE here would policy-check those owner inserts/reads against an
-- empty GUC and fail them, stranding every new sign-up. Plain ENABLE
-- keeps the owner exempt (it bypasses RLS by virtue of ownership) while
-- the marfa_app role-on-checkout path is still filtered.
--
-- **Deliberately EXCLUDED — no usable tenant key:**
--   - oauth_device_codes — its only tenant link is connection_item_id
--     (FK to items), which is NULL pre-consent. An items-join policy would
--     hide pending device codes from marfa_app and break the device flow.
--   - rate_limit_windows — has no tenant column at all and is accessed
--     pre-RLS on the owner connection.

-- users — direct tenant_id (NOT NULL).
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "users_tenant_isolation" ON "users";
--> statement-breakpoint
CREATE POLICY "users_tenant_isolation" ON "users"
  FOR ALL TO "marfa_app"
  USING (tenant_id::text = current_setting('marfa.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- tenant_quotas — tenant_id is the PK.
ALTER TABLE "tenant_quotas" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_quotas_tenant_isolation" ON "tenant_quotas";
--> statement-breakpoint
CREATE POLICY "tenant_quotas_tenant_isolation" ON "tenant_quotas"
  FOR ALL TO "marfa_app"
  USING (tenant_id::text = current_setting('marfa.tenant_id', true)
         OR tenant_id IS NULL);
--> statement-breakpoint

-- outbound_webhook_deliveries — no tenant_id; join to parent via webhook_id.
ALTER TABLE "outbound_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "outbound_webhook_deliveries_tenant_isolation" ON "outbound_webhook_deliveries";
--> statement-breakpoint
CREATE POLICY "outbound_webhook_deliveries_tenant_isolation" ON "outbound_webhook_deliveries"
  FOR ALL TO "marfa_app"
  USING (EXISTS (
    SELECT 1 FROM "outbound_webhooks" w
      WHERE w.id = "outbound_webhook_deliveries".webhook_id
        AND (w.tenant_id::text = current_setting('marfa.tenant_id', true)
             OR w.tenant_id IS NULL)
  ));
--> statement-breakpoint

-- inbound_webhook_events — no tenant_id; join to parent via inbound_webhook_id.
ALTER TABLE "inbound_webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "inbound_webhook_events_tenant_isolation" ON "inbound_webhook_events";
--> statement-breakpoint
CREATE POLICY "inbound_webhook_events_tenant_isolation" ON "inbound_webhook_events"
  FOR ALL TO "marfa_app"
  USING (EXISTS (
    SELECT 1 FROM "inbound_webhooks" w
      WHERE w.id = "inbound_webhook_events".inbound_webhook_id
        AND (w.tenant_id::text = current_setting('marfa.tenant_id', true)
             OR w.tenant_id IS NULL)
  ));
