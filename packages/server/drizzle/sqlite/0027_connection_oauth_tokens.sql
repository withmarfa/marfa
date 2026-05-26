-- Workstream 2 PR 6: encrypted OAuth-token storage for external-service
-- connectors.
--
-- One row per system.connection (unique on connection_id). Tokens are
-- encrypted at rest under HKDF(MARFA_AUTH_SECRET, info=
-- "connection-oauth-tokens"); the proxy route decrypts at request time
-- and stamps `Authorization: Bearer <access>` on the upstream call.
-- See packages/server/src/crypto/secret-encryption.ts for the helper.
--
-- previous_refresh_hash retains the SHA-256 of the most recent
-- rotated-out refresh token. Forensic only; the active enforcement of
-- replay is the upstream's `invalid_grant` response.

CREATE TABLE `connection_oauth_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `connection_id` text NOT NULL,
  `tenant_id` text,
  `access_token_encrypted` text NOT NULL,
  `refresh_token_encrypted` text,
  `expires_at` text NOT NULL,
  `scopes` text DEFAULT '[]' NOT NULL,
  `previous_refresh_hash` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_connection_oauth_tokens_connection_id` ON `connection_oauth_tokens` (`connection_id`);
