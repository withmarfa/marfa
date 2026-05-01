-- Workstream 2 PR 8: cycle-detection metadata on event_log.
-- See sqlite/0029_event_log_cycle_metadata.sql for design notes.

ALTER TABLE event_log ADD COLUMN originating_connection_id TEXT;
--> statement-breakpoint
ALTER TABLE event_log ADD COLUMN hop_count INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX idx_event_log_originating_connection_id ON event_log(originating_connection_id, id);
