-- A resuming client asks "what changed after T" and walks the answer in
-- (updated_at, id) order. Without an index in that shape the read is a scan
-- plus a sort, on the query such a client issues most often.
--
-- `id` is part of the index rather than left to the ORDER BY, because the
-- keyset cursor compares both columns to page through rows that share a
-- millisecond, and a bulk write produces many of those.
--
-- Deliberately not led by space_id. A space-leading composite is the better
-- index where many spaces share a database, and serves a single-space
-- deployment not at all: nothing binds a space there, so no predicate
-- constrains the leading column and the planner will not walk it for the
-- ordering. Leading on updated_at serves both.
CREATE INDEX IF NOT EXISTS `idx_items_updated_at_id` ON `items` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_edges_updated_at_id` ON `edges` (`updated_at`,`id`);
