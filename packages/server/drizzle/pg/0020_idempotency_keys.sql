-- Idempotency-Key middleware: cached responses indexed by (api_key_id, key)
-- so that replays of POST/PATCH/DELETE return the original outcome without
-- re-executing the handler.
--
-- Sized for the sync-client write queue: every drained mutation stamps an
-- Idempotency-Key (UUIDv7), so under steady state we expect roughly
-- one row per outbound mutation × IDEMPOTENCY_RETENTION_HOURS / 24 hours.
-- The cleanup job purges expired rows hourly.

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
