-- The top role becomes `instance_admin`.

-- `admin` sat above `space_admin` and named no scope, so the wider of the two
-- read as the generic one. Both admin-shaped roles now say what they govern.
--
-- Two tables, because the column lives on both. `0073_rename_tenant_to_space.sql`
-- did `api_keys` and missed `users`, and every account holder lost their own
-- admin surfaces until `0093` repaired it. That is the specific mistake this
-- migration is written to not repeat.
--
-- Narrowing, not widening, which is the opposite of `0093` and is why the
-- ordering mattered here. This turns a value the previous build recognizes
-- into one only the new build does, and the deploy applies migrations while
-- the previous build is still serving. So the build that reads both shipped
-- first, in its own deploy; this file is safe only behind it.

UPDATE "users" SET "role" = 'instance_admin' WHERE "role" = 'admin';
--> statement-breakpoint
UPDATE "api_keys" SET "role" = 'instance_admin' WHERE "role" = 'admin';
