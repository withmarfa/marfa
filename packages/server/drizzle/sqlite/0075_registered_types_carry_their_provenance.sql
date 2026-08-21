-- Registered types gain provenance. See the Postgres sibling for the full
-- reasoning; the short version is that immutability stops being a compiled
-- set and becomes a row property, which is what lets a type an integration
-- published be updatable by that integration's own package and by nothing
-- else.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so these run exactly once. The
-- migrator applies each file once by journal timestamp, which is the same
-- guarantee.
ALTER TABLE custom_types ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE custom_types ADD COLUMN family TEXT;
--> statement-breakpoint
ALTER TABLE custom_types ADD COLUMN owner_integration TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_custom_types_origin ON custom_types (origin);
