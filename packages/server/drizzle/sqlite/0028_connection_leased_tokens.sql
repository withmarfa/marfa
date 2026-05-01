-- Workstream 2 PR 7: short-TTL leased bearer tokens for connectors.
--
-- Capability gating ties each lease to a manifest-declared
-- `oauth_requirements: { <capability_id>: "leased" }` entry — the lease
-- route refuses requests for capabilities the manifest doesn't list.
-- Storage is hashed (SHA-256) like API keys: the lease IS a bearer
-- token, so hashing-on-storage is the right shape. Plaintext is
-- returned ONCE on issue.

CREATE TABLE `connection_leased_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `connection_id` text NOT NULL,
  `tenant_id` text,
  `capability_id` text NOT NULL,
  `lease_token_hash` text NOT NULL,
  `scopes` text DEFAULT '[]' NOT NULL,
  `expires_at` text NOT NULL,
  `revoked_at` text,
  `issued_by_key_id` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_connection_leased_tokens_hash` ON `connection_leased_tokens` (`lease_token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_connection_leased_tokens_connection_id` ON `connection_leased_tokens` (`connection_id`, `expires_at`);
