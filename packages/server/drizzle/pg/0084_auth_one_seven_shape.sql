-- The authorization library's 1.7 line adds columns to the four OAuth
-- tables it owns. Marfa's own migration chain carries them, as it has
-- for every prior shape change to these tables, because the library's
-- migrator has never run against these databases.
--
-- Every column is nullable, deliberately: the running 1.6 build inserts
-- rows without them during the deploy window and under any revert, so
-- the old code serves this schema indefinitely without noticing. That
-- is what makes the version bump itself a clean, code-only revert. No
-- constraint is tightened here and none should be later without its own
-- reasoning.
--
-- Array-typed columns are native text[]: the library's adapter declares
-- array support on Postgres, and plain text columns silently
-- JSON-stringify (the exact defect a previous migration on these tables
-- unwound).
ALTER TABLE "auth_oauth_access_token"
  ADD COLUMN IF NOT EXISTS "authorization_code_id" text,
  ADD COLUMN IF NOT EXISTS "confirmation" jsonb,
  ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[],
  ADD COLUMN IF NOT EXISTS "resources" text[],
  ADD COLUMN IF NOT EXISTS "revoked" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_oauth_access_token_authorization_code_id"
  ON "auth_oauth_access_token" ("authorization_code_id");
--> statement-breakpoint
ALTER TABLE "auth_oauth_refresh_token"
  ADD COLUMN IF NOT EXISTS "authorization_code_id" text,
  ADD COLUMN IF NOT EXISTS "confirmation" jsonb,
  ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[],
  ADD COLUMN IF NOT EXISTS "resources" text[],
  ADD COLUMN IF NOT EXISTS "rotated_at" timestamp,
  ADD COLUMN IF NOT EXISTS "rotation_replay_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "rotation_replay_response" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_oauth_refresh_token_authorization_code_id"
  ON "auth_oauth_refresh_token" ("authorization_code_id");
--> statement-breakpoint
ALTER TABLE "auth_oauth_consent"
  ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[],
  ADD COLUMN IF NOT EXISTS "resources" text[];
--> statement-breakpoint
ALTER TABLE "auth_oauth_client"
  ADD COLUMN IF NOT EXISTS "application_type" text,
  ADD COLUMN IF NOT EXISTS "backchannel_logout_session_required" boolean,
  ADD COLUMN IF NOT EXISTS "backchannel_logout_uri" text,
  ADD COLUMN IF NOT EXISTS "client_credentials_scopes" text[],
  ADD COLUMN IF NOT EXISTS "client_discovery_id" text,
  ADD COLUMN IF NOT EXISTS "dpop_bound_access_tokens" boolean,
  ADD COLUMN IF NOT EXISTS "jwks" text,
  ADD COLUMN IF NOT EXISTS "jwks_uri" text;
--> statement-breakpoint
-- 1.7 keys account lookups on (issuer, account_id); a row the new build
-- cannot find by that pair is an account whose sign-in fails. Local
-- credential accounts carry the literal below; OAuth identities (none
-- exist on either live database, but a self-host may hold them) carry
-- the namespaced provider form the library writes for providers without
-- an issuer of their own. Idempotent: only NULL rows are touched, so a
-- re-run after the deploy window sweeps any row the old build minted
-- mid-roll.
ALTER TABLE "auth_account" ADD COLUMN IF NOT EXISTS "issuer" text;
--> statement-breakpoint
UPDATE "auth_account" SET "issuer" =
  CASE WHEN "provider_id" = 'credential' THEN 'local:credential'
       ELSE 'local:oauth:' || "provider_id" END
  WHERE "issuer" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_account_issuer_account_id"
  ON "auth_account" ("issuer", "account_id");
--> statement-breakpoint
-- The signing-key table records which algorithm each pair was minted
-- for (and the curve for EC/OKP keys) so verification can select among
-- heterogeneous keys. Nullable: rows minted under 1.6 predate the
-- columns, and the library reads null as its configured default.
ALTER TABLE "auth_jwks" ADD COLUMN IF NOT EXISTS "alg" text;
--> statement-breakpoint
ALTER TABLE "auth_jwks" ADD COLUMN IF NOT EXISTS "crv" text;
