-- Workstream 2 PR 1: rename outbound webhook tables for symmetry with the
-- inbound webhook subsystem landing in WS2 PR 5. Mechanical rename only —
-- no semantic change, no schema change beyond table and index identifiers.
-- ALTER TABLE RENAME preserves rows. SQLite cannot rename indexes in place,
-- so they're dropped and recreated under the new name.

ALTER TABLE `webhooks` RENAME TO `outbound_webhooks`;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` RENAME TO `outbound_webhook_deliveries`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_webhook_deliveries_webhook_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_webhook_deliveries_pending`;--> statement-breakpoint
CREATE INDEX `idx_outbound_webhook_deliveries_webhook_id` ON `outbound_webhook_deliveries` (`webhook_id`);--> statement-breakpoint
CREATE INDEX `idx_outbound_webhook_deliveries_pending` ON `outbound_webhook_deliveries` (`next_attempt_at`) WHERE `status` = 'pending';
