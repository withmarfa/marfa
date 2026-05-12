-- T-108: edges rework.
-- See the matching PG migration `0045_drop_retired_edge_types.sql`
-- for the full rationale. Drops rows of the retired edge types
-- (`pinned-to`, `annotates`) from the edges table.

DELETE FROM edges WHERE edge_type IN ('pinned-to', 'annotates');
