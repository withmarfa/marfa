-- T-072: rename `system.connection.kind` enum values.
--
-- Wire-format rename, no legacy aliasing. The kind value lives in the
-- `properties` JSONB column on `system.connection` items (not a column,
-- not an enum), so this is a one-shot data UPDATE rather than a schema
-- migration.
--
--   user-app-grant            -> app
--   external-service-connector -> integration
--   tenant-share              -> tenant
--
-- Idempotent: re-running over already-renamed rows finds zero matches
-- and no-ops. Fresh DBs match zero rows on first run.
UPDATE items
SET properties = jsonb_set(
  properties,
  '{kind}',
  CASE properties->>'kind'
    WHEN 'user-app-grant' THEN '"app"'::jsonb
    WHEN 'external-service-connector' THEN '"integration"'::jsonb
    WHEN 'tenant-share' THEN '"tenant"'::jsonb
  END
)
WHERE type = 'system.connection'
  AND properties->>'kind' IN (
    'user-app-grant',
    'external-service-connector',
    'tenant-share'
  );
