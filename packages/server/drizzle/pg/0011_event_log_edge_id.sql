-- Wave 2 PR 4 commit 13: event_log grows an edge_id column so edge events
-- (edge.created / edge.deleted) can flow through the same pub/sub and SSE
-- replay path as item events. item_id stays NOT NULL and carries the edge's
-- source_id for edge events so existing Last-Event-ID filtering continues
-- to work by item; edge_id lets subscribers filter by a specific edge too.

ALTER TABLE event_log ADD COLUMN IF NOT EXISTS edge_id TEXT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_event_log_edge_id ON event_log(edge_id);
