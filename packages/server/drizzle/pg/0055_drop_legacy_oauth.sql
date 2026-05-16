-- T-131: drop the homegrown OAuth-protocol tables. Their replacements
-- (`auth_oauth_client`, `auth_oauth_access_token`, `auth_oauth_refresh_token`,
-- `auth_oauth_consent`) landed in migration 0054 and are owned by the
-- @better-auth/oauth-provider plugin.
--
-- Pre-launch positioning means no real users to migrate; staging OAuth
-- state was cleared and re-created via the new flow. Per the project's
-- "no legacy carry-over" principle, no dual surface, no data preservation.
--
-- The `oauth_device_codes` table is intentionally KEPT — it's the Myme-
-- owned state machine for the device-flow surfaces (`/auth/device*`)
-- which the plugin doesn't replace. We drop its FK to `oauth_clients`
-- and rely on application-enforced integrity against the plugin's
-- business `client_id`.

-- Drop the FK constraint so the parent table drop succeeds.
ALTER TABLE "oauth_device_codes" DROP CONSTRAINT IF EXISTS "oauth_device_codes_client_id_oauth_clients_id_fk";
--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_tokens";
--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_codes";
--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_clients";
