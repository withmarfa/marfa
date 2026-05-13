-- T-115: drop the dead per-type retention map from `TenantConfig`.
--
-- T-109 dropped the tenant-wide `feed_retention_days` knob, the
-- `FeedExpirer` job, and `expireFeedOlderThan`, but missed the per-
-- type `retention?: Record<typeId, { feed_days: int }>` map on
-- `TenantConfig` (a separate, older mechanism). The map was still
-- accepted on `PUT /tenants/current/config`, validated against the
-- type registry, persisted, and round-tripped in tests — yet no code
-- read it. The wire schema, validator, type, and SDK comments are
-- removed in the same PR.
--
-- This migration strips the `retention` JSON key from existing
-- `tenants.config` rows so it doesn't linger as a silent payload that
-- no longer drives anything. No-op on fresh databases (the key has
-- never been written) and on tenants that never set it (the guard
-- predicate ensures we only rewrite rows that actually carry the key).

UPDATE "tenants"
SET "config" = "config" - 'retention'
WHERE "config" ? 'retention';
