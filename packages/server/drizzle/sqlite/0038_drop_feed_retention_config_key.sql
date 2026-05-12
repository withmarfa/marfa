-- T-109: feed retention decoupled from the tier axis.
-- See the matching PG migration `0045_drop_feed_retention_config_key.sql`
-- for full rationale. Strips the `feed_retention_days` property from
-- existing JSON `tenants.config` rows; no-op on fresh databases.

UPDATE tenants
SET config = json_remove(config, '$.feed_retention_days')
WHERE json_type(config, '$.feed_retention_days') IS NOT NULL;
