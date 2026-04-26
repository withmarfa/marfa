-- Idempotency-Key middleware: cached responses indexed by (api_key_id, key).
-- See packages/server/drizzle/pg/0020_idempotency_keys.sql for the rationale.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  api_key_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_pk
  ON idempotency_keys (api_key_id, key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at);
