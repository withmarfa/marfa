-- Wave 2 PR 4 pre-merge fix-up: relax event_log.item_id to NULL so edge
-- events can store item_id=NULL + edge_id=<edge.id>. SQLite has no
-- ALTER COLUMN DROP NOT NULL — rebuild the table with the relaxed
-- constraint, copy rows, drop the old one, rename. Indexes are
-- recreated explicitly (indexes drop when the table drops).

PRAGMA foreign_keys = OFF;--> statement-breakpoint
CREATE TABLE `event_log_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_type` text NOT NULL,
  `item_id` text,
  `edge_id` text,
  `tenant_id` text,
  `payload` text NOT NULL,
  `created_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `event_log_new` (id, event_type, item_id, edge_id, tenant_id, payload, created_at)
  SELECT id, event_type, item_id, edge_id, tenant_id, payload, created_at FROM `event_log`;--> statement-breakpoint
DROP TABLE `event_log`;--> statement-breakpoint
ALTER TABLE `event_log_new` RENAME TO `event_log`;--> statement-breakpoint
CREATE INDEX `idx_event_log_created_at` ON `event_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_event_log_edge_id` ON `event_log` (`edge_id`);--> statement-breakpoint
PRAGMA foreign_keys = ON;
