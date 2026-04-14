-- Backfill schema_version on existing items. See the matching pg/ migration
-- for context. SQLite quoting differs (backticks); SQL is otherwise the same.
UPDATE `items` SET `schema_version` = 1 WHERE `schema_version` IS NULL;
