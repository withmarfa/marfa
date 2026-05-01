-- Workstream 2 PR 7: short-TTL leased bearer tokens for connectors.
--
-- See sqlite/0028_connection_leased_tokens.sql for design notes; this
-- file mirrors that schema for the Postgres dialect.

CREATE TABLE connection_leased_tokens (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  tenant_id TEXT,
  capability_id TEXT NOT NULL,
  lease_token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  issued_by_key_id TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_connection_leased_tokens_hash ON connection_leased_tokens(lease_token_hash);
--> statement-breakpoint
CREATE INDEX idx_connection_leased_tokens_connection_id ON connection_leased_tokens(connection_id, expires_at);
