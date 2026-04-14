-- Captures the partial index on webhook_deliveries that previously existed
-- only as inline DDL in pg/connection.ts. Drizzle Kit can't express partial
-- indexes via the schema DSL, so this migration is hand-authored.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
