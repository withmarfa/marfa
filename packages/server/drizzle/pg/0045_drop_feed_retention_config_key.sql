-- T-109: feed retention decoupled from the tier axis.
--
-- The `feed_retention_days` field on `TenantConfig` (stored as a JSON
-- sub-property on the `tenants.config` text column) is no longer read
-- anywhere: the `FeedExpirer` cleanup job, the `expireFeedOlderThan`
-- ItemStore method, and the matching env vars (`FEED_RETENTION_DAYS`,
-- `FEED_EXPIRY_INTERVAL_MS`) are all removed in the same PR.
--
-- The migration strips the property from existing JSON rows so it
-- doesn't linger as a silent payload that no longer drives anything.
-- No-op on fresh databases (the property hasn't been written) and on
-- tenants that never set it (the guard predicate ensures we only
-- rewrite rows that actually carry the key).

UPDATE "tenants"
SET "config" = "config" - 'feed_retention_days'
WHERE "config" ? 'feed_retention_days';
