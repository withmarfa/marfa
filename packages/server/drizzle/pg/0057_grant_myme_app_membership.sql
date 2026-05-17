-- T-168: grant myme_app role membership to the connection user.
--
-- The original RLS migration (0035) creates the `myme_app` role and grants
-- it CRUD on tenant-scoped tables, but never grants the migrator user
-- MEMBERSHIP in the role. PostgreSQL 16+ no longer auto-grants membership
-- on CREATE ROLE — the creator gets admin option (where applicable) but
-- must explicitly GRANT for the role to be settable via `SET ROLE`.
--
-- CI / Docker bootstraps as a superuser, so the latent gap never showed.
-- T-146 (RLS-on-by-default) activated the per-request `SET LOCAL ROLE
-- myme_app` — and any tenant-scoped request on a non-superuser
-- deployment (Atlas) immediately 500s with `must be a member of role
-- "myme_app"`.
--
-- This migration grants membership to whatever user is running the
-- migrator. On dev/CI it's a no-op (superuser already has implicit
-- membership; GRANT is idempotent). On a non-superuser deployment it
-- requires the migrator to have admin option on `myme_app` — typically
-- the case when the migrator created the role. If the migrator lacks
-- admin option (e.g. role was provisioned out-of-band by a different
-- operator), the GRANT raises `insufficient_privilege`; the EXCEPTION
-- handler turns that into a clear NOTICE rather than aborting the
-- migration. An operator with sufficient privileges must run the GRANT
-- once before tenant-scoped requests will succeed.
--
-- See: T-168, T-146, T-025.

DO $$
BEGIN
  BEGIN
    EXECUTE 'GRANT myme_app TO ' || quote_ident(current_user);
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE
        'Could not GRANT myme_app TO %: %. An operator with admin option on myme_app (or a superuser) must run this once before tenant-scoped requests will succeed on this deployment.',
        current_user, SQLERRM;
  END;
END
$$;
