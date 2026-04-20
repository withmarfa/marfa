-- Backfill source and origin on existing items.
-- See the matching pg/ migration for context. SQLite quoting differs
-- (backticks); SQL is otherwise the same.
UPDATE `items` SET `source` = '<unknown>' WHERE `source` IS NULL;
--> statement-breakpoint
UPDATE `items` SET `origin` = 'user' WHERE `origin` IS NULL OR `origin` NOT IN ('user', 'ai', 'worker');
