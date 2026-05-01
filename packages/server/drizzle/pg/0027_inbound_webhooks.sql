-- Workstream 2 PR 5: inbound webhook subsystem.
--
-- See sqlite/0025_inbound_webhooks.sql for the design notes — this file
-- mirrors that schema for the Postgres dialect. PG handles multi-statement
-- strings via a single execute, but we use the breakpoint marker for
-- cross-dialect convention parity (lesson from PR 1).

CREATE TABLE inbound_webhooks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  connection_id TEXT NOT NULL,
  external_service_id TEXT,
  secret_encrypted TEXT NOT NULL,
  verification_method TEXT NOT NULL,
  verification_adapter_id TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);--> statement-breakpoint
CREATE INDEX idx_inbound_webhooks_connection_id ON inbound_webhooks(connection_id);--> statement-breakpoint
CREATE TABLE inbound_webhook_events (
  id TEXT PRIMARY KEY,
  inbound_webhook_id TEXT NOT NULL,
  external_delivery_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  verified INTEGER NOT NULL,
  processed_at TEXT,
  processing_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT
);--> statement-breakpoint
CREATE UNIQUE INDEX idx_inbound_webhook_events_dedup ON inbound_webhook_events(inbound_webhook_id, external_delivery_id);--> statement-breakpoint
CREATE INDEX idx_inbound_webhook_events_pending ON inbound_webhook_events(next_attempt_at) WHERE processed_at IS NULL AND processing_error IS NULL;
