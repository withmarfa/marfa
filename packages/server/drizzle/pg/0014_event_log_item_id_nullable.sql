-- Wave 2 PR 4 pre-merge fix-up: event_log.item_id relaxes to NULL so
-- edge events can record item_id=NULL + edge_id=<edge.id>. Previously
-- publishEdge was writing item_id = edge.source_id as a NOT NULL
-- workaround (Q10 explicitly rejected that).

ALTER TABLE event_log ALTER COLUMN item_id DROP NOT NULL;
