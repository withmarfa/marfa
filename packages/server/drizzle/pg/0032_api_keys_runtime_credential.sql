-- Workstream 3 Layer 1 PR 4: per-Connection runtime credentials.
-- See sqlite/0030_api_keys_runtime_credential.sql for design notes.

ALTER TABLE api_keys ADD COLUMN is_runtime_credential BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN connection_id TEXT;
--> statement-breakpoint
CREATE INDEX idx_api_keys_connection_id ON api_keys(connection_id) WHERE connection_id IS NOT NULL;
