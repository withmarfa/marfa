-- Workstream 2 PR 8: cycle-detection metadata on event_log.
--
-- Adds two columns and one supporting index. The cycle-detection
-- enforcement lives in pubsub.publish: when an event's hop_count would
-- exceed the tenant's max_event_hop_budget, the bus drops the event and
-- emits a `system.activity` row with severity `error`.

ALTER TABLE `event_log` ADD COLUMN `originating_connection_id` text;
--> statement-breakpoint
ALTER TABLE `event_log` ADD COLUMN `hop_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX `idx_event_log_originating_connection_id` ON `event_log` (`originating_connection_id`, `id`);
