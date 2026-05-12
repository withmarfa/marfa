-- T-110: drop `origin` from items and `default_origin` from api_keys.
-- See the matching PG migration `0045_drop_origin_and_default_origin.sql`
-- for the full rationale. SQLite 3.35+ supports DROP COLUMN directly;
-- better-sqlite3 ships well above that.

ALTER TABLE items DROP COLUMN origin;--> statement-breakpoint
ALTER TABLE api_keys DROP COLUMN default_origin;
