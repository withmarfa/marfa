-- Workstream 2 PR 5: inbound webhook subsystem.
--
-- Two new tables. inbound_webhooks holds the per-Connection subscription
-- (one row per external service the connector listens to). secret_encrypted
-- stores AES-256-GCM(secret) under HKDF(MYME_AUTH_SECRET) — verification
-- requires the raw secret server-side, so a one-way hash isn't usable
-- (the same primitive PR 6 reuses for OAuth tokens).
--
-- inbound_webhook_events is the receipt log: one row per POST to
-- /webhooks/inbound/:id. The unique (inbound_webhook_id, external_delivery_id)
-- index enforces idempotency at insert time — duplicate deliveries from
-- the sender collapse to the existing row. The pending partial index
-- gives WS3's reactive runner a cheap pull queue (verified-but-not-
-- processed-and-not-DLQ rows).

CREATE TABLE `inbound_webhooks` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `connection_id` text NOT NULL,
  `external_service_id` text,
  `secret_encrypted` text NOT NULL,
  `verification_method` text NOT NULL,
  `verification_adapter_id` text,
  `events` text DEFAULT '[]' NOT NULL,
  `disabled` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_inbound_webhooks_connection_id` ON `inbound_webhooks` (`connection_id`);--> statement-breakpoint
CREATE TABLE `inbound_webhook_events` (
  `id` text PRIMARY KEY NOT NULL,
  `inbound_webhook_id` text NOT NULL,
  `external_delivery_id` text NOT NULL,
  `received_at` text NOT NULL,
  `payload` text NOT NULL,
  `verified` integer NOT NULL,
  `processed_at` text,
  `processing_error` text,
  `retry_count` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` text
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbound_webhook_events_dedup` ON `inbound_webhook_events` (`inbound_webhook_id`, `external_delivery_id`);--> statement-breakpoint
CREATE INDEX `idx_inbound_webhook_events_pending` ON `inbound_webhook_events` (`next_attempt_at`) WHERE `processed_at` IS NULL AND `processing_error` IS NULL;
