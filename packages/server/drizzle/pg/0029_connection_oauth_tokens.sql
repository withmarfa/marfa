-- Workstream 2 PR 6: encrypted OAuth-token storage for external-service
-- connectors.
--
-- See sqlite/0027_connection_oauth_tokens.sql for the design notes; this
-- file mirrors that schema for the Postgres dialect.

CREATE TABLE connection_oauth_tokens (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  tenant_id TEXT,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  expires_at TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  previous_refresh_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_connection_oauth_tokens_connection_id ON connection_oauth_tokens(connection_id);
