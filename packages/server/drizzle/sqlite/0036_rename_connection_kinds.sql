-- T-072: rename `system.connection.kind` enum values.
--
-- Wire-format rename, no legacy aliasing. The kind value lives in the
-- `properties` JSON column on `system.connection` items (not a column,
-- not an enum), so this is a one-shot data UPDATE rather than a schema
-- migration. SQLite's JSON1 functions handle the in-place rewrite.
--
--   user-app-grant            -> app
--   external-service-connector -> integration
--   tenant-share              -> tenant
--
-- Idempotent: re-running over already-renamed rows finds zero matches
-- and no-ops. Fresh DBs match zero rows on first run.
UPDATE items
SET properties = json_set(
  properties,
  '$.kind',
  CASE json_extract(properties, '$.kind')
    WHEN 'user-app-grant' THEN 'app'
    WHEN 'external-service-connector' THEN 'integration'
    WHEN 'tenant-share' THEN 'tenant'
  END
)
WHERE type = 'system.connection'
  AND json_extract(properties, '$.kind') IN (
    'user-app-grant',
    'external-service-connector',
    'tenant-share'
  );
