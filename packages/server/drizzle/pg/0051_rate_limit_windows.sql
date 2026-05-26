-- T-026: cluster-shared rate-limit + per-email throttle counters.
-- One physical table, two consumer surfaces discriminated by `family`.
-- See packages/server/src/storage/pg/schema.ts for the full design note.
CREATE TABLE IF NOT EXISTS "rate_limit_windows" (
  "family" text NOT NULL,
  "window_key" text NOT NULL,
  "count" integer NOT NULL,
  "expires_at" text NOT NULL,
  CONSTRAINT "rate_limit_windows_family_window_key_pk" PRIMARY KEY ("family", "window_key")
);
CREATE INDEX IF NOT EXISTS "idx_rate_limit_windows_expires_at"
  ON "rate_limit_windows" USING btree ("expires_at");

-- Grant the application role permission on the new table so the
-- rate-limit middleware can write to it even when RLS is enforced.
-- The middleware currently runs BEFORE the RLS role-switch wrapper
-- so the GRANT isn't strictly required today, but keeping the table
-- under `marfa_app`'s explicit permission list future-proofs against
-- middleware re-ordering and matches the pattern for tenant_quotas /
-- email_suppressions. DO block makes the GRANT idempotent on fresh
-- and migrated databases alike.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marfa_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_windows" TO "marfa_app";
  END IF;
END
$$;
