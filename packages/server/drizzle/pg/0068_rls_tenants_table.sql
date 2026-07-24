-- Fence the `tenants` table itself under RLS.
--
-- `tenants` was granted full CRUD to `marfa_app` back in 0035 (the
-- "instance-wide read paths" carve-out) but never got a policy, so it
-- outlived the sweep in 0067. Every other table carrying tenant data is
-- now policied; this one was the last row-per-tenant table where an
-- unscoped query as `marfa_app` could read — or write — across the whole
-- instance, leaving the application-layer role gate as the only fence.
-- Tenant names and owner emails are exactly the kind of cross-customer
-- data RLS exists to keep behind a second lock.
--
-- The tenant key here is the primary key itself, so the policy is a plain
-- equality on `id`. There is no `OR ... IS NULL` allowance: `id` is NOT
-- NULL, and the deployments the allowance exists for elsewhere never
-- reach this policy anyway (see below).
--
-- **Every legitimate reader still works:**
--   - Own-tenant reads under the request wrapper — `GET/PUT
--     /tenants/me/config` and the `getConfig` lookups behind item writes,
--     search, and the pubsub hop budget all address the caller's own
--     tenant, which the equality admits.
--   - Platform-admin routes (`/admin/tenants*`, `/tenants/{id}/quotas`)
--     carry no `tenant_id`, so the RLS middleware never installs the
--     role switch and they run as the table owner, which is RLS-exempt.
--   - The tenant-suspension middleware reads status before the RLS
--     wrapper is installed, also on the owner connection.
--   - Background retention jobs fan out via `TenantStore.list()` off the
--     request path, again as the owner.
--   - Better Auth sign-up provisioning creates the tenant row inside a
--     transaction that explicitly resets to the owner role.
--
-- **No FORCE — same reasoning as 0067.** Plain `ENABLE ROW LEVEL
-- SECURITY` keeps the table owner exempt, which the four owner-connection
-- paths above depend on. `FORCE` would policy-check them against an unset
-- `marfa.tenant_id` and fail, stranding sign-up and tenant administration.
--
-- **`settings` stays deliberately unpoliced.** It is the other table 0035
-- granted for "instance-wide reads", but unlike `tenants` it is genuinely
-- instance-scoped configuration with no per-tenant row (the bootstrap
-- sentinel lives there). There is no tenant key to filter on, so a policy
-- would have nothing to express.

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenants_self_isolation" ON "tenants";
--> statement-breakpoint
CREATE POLICY "tenants_self_isolation" ON "tenants"
  FOR ALL TO "marfa_app"
  USING (id::text = current_setting('marfa.tenant_id', true));
