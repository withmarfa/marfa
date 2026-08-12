-- The authorization library's 1.7 line adds columns to the four OAuth
-- tables it owns; the Postgres sibling migration carries the reasoning.
-- SQLite stores the library's array- and json-typed fields as text and
-- its dates as integer epoch, matching every existing column on these
-- tables. Every column is nullable so the running 1.6 build serves this
-- schema without noticing.
ALTER TABLE `auth_oauth_access_token` ADD COLUMN `authorization_code_id` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_access_token` ADD COLUMN `confirmation` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_access_token` ADD COLUMN `requested_user_info_claims` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_access_token` ADD COLUMN `resources` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_access_token` ADD COLUMN `revoked` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_access_token_authorization_code_id`
  ON `auth_oauth_access_token` (`authorization_code_id`);
--> statement-breakpoint
ALTER TABLE `auth_oauth_refresh_token` ADD COLUMN `authorization_code_id` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_refresh_token` ADD COLUMN `confirmation` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_refresh_token` ADD COLUMN `requested_user_info_claims` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_refresh_token` ADD COLUMN `resources` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_refresh_token` ADD COLUMN `rotated_at` integer;
--> statement-breakpoint
ALTER TABLE `auth_oauth_refresh_token` ADD COLUMN `rotation_replay_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `auth_oauth_refresh_token` ADD COLUMN `rotation_replay_response` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_refresh_token_authorization_code_id`
  ON `auth_oauth_refresh_token` (`authorization_code_id`);
--> statement-breakpoint
ALTER TABLE `auth_oauth_consent` ADD COLUMN `requested_user_info_claims` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_consent` ADD COLUMN `resources` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_client` ADD COLUMN `application_type` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_client` ADD COLUMN `backchannel_logout_session_required` integer;
--> statement-breakpoint
ALTER TABLE `auth_oauth_client` ADD COLUMN `backchannel_logout_uri` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_client` ADD COLUMN `client_credentials_scopes` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_client` ADD COLUMN `client_discovery_id` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_client` ADD COLUMN `dpop_bound_access_tokens` integer;
--> statement-breakpoint
ALTER TABLE `auth_oauth_client` ADD COLUMN `jwks` text;
--> statement-breakpoint
ALTER TABLE `auth_oauth_client` ADD COLUMN `jwks_uri` text;
--> statement-breakpoint
-- The account lookup key gains its issuer half; see the pg sibling for
-- the reasoning and the backfill rule.
ALTER TABLE `auth_account` ADD COLUMN `issuer` text;
--> statement-breakpoint
UPDATE `auth_account` SET `issuer` =
  CASE WHEN `provider_id` = 'credential' THEN 'local:credential'
       ELSE 'local:oauth:' || `provider_id` END
  WHERE `issuer` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_auth_account_issuer_account_id`
  ON `auth_account` (`issuer`, `account_id`);
--> statement-breakpoint
-- Key-algorithm columns on the signing-key table; see the pg sibling.
ALTER TABLE `auth_jwks` ADD COLUMN `alg` text;
--> statement-breakpoint
ALTER TABLE `auth_jwks` ADD COLUMN `crv` text;
