-- The space rename left every user row holding the old role value.
--
-- `0073_rename_tenant_to_space.sql` renamed the word across the schema and
-- realigned the stored role on `api_keys`, but the same value lives on
-- `users` and was missed. `0062_t224_naming.sql` did both tables for the
-- previous rename of this column, which is the shape this restores.
--
-- The consequence was not cosmetic. `users.role` is projected onto OAuth
-- bearer principals, and `space_admin` is the value every gate compares
-- against, so an account holder carrying `tenant_admin` matched no branch
-- and was refused on every admin-gated route while API-key callers were
-- unaffected.
--
-- Widening, not narrowing: it turns a value nothing recognizes into one
-- every current build already handles, so it needs no ordering dance
-- against the deploy.

UPDATE "users" SET "role" = 'space_admin' WHERE "role" = 'tenant_admin';
