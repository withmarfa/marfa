-- Wave 2 PR 4 commit 13: event_log grows an edge_id column so edge events
-- (edge.created / edge.deleted) share the pub/sub + SSE replay path with
-- item events. See pg equivalent for the full rationale.

ALTER TABLE `event_log` ADD COLUMN `edge_id` text;--> statement-breakpoint
CREATE INDEX `idx_event_log_edge_id` ON `event_log` (`edge_id`);
