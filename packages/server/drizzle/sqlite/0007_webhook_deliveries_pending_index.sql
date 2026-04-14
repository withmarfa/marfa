-- See the matching pg/ migration for context. SQLite supports partial
-- indexes; quoting differs (backticks for identifiers).
CREATE INDEX IF NOT EXISTS `idx_webhook_deliveries_pending`
  ON `webhook_deliveries`(`next_attempt_at`) WHERE `status` = 'pending';
