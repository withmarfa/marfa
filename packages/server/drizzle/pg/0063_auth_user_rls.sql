-- T-271: GET /profile/me mirrors the user's email from the Better-Auth
-- `auth_user` table. Under RLS the request runs as `marfa_app`, which had no
-- grant on `auth_user` (and `auth_user` had no policy), so the lookup threw
-- "permission denied for table auth_user" and the endpoint 500'd.
--
-- Grant the role SELECT and add a policy that exposes only the caller's own
-- identity row, joined through `users` on the tenant GUC — so a tenant can
-- read the email for its own user and no other. The table-owner role that
-- Better Auth runs as bypasses RLS, so sign-in and the rest of the auth flow
-- are unaffected. PG-only; SQLite has no RLS.

GRANT SELECT ON "auth_user" TO "marfa_app";
--> statement-breakpoint
ALTER TABLE "auth_user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "auth_user_self" ON "auth_user";
--> statement-breakpoint
CREATE POLICY "auth_user_self" ON "auth_user"
  FOR SELECT TO "marfa_app"
  USING (id IN (
    SELECT auth_user_id FROM "users"
    WHERE tenant_id::text = current_setting('marfa.tenant_id', true)
  ));
