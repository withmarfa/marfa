-- T-072: rename `system.connection.kind` enum values.
--
-- Wire-format rename, no legacy aliasing. The kind value lives in the
-- `properties` column (stored as TEXT carrying JSON) on system.connection
-- items, so this is a one-shot data UPDATE rather than a schema
-- migration. Cast to jsonb to use the JSON operators, then back to
-- text to write — items.properties is text-typed for dialect parity
-- with SQLite.
--
--   user-app-grant            -> app
--   external-service-connector -> integration
--   tenant-share              -> tenant
--
-- Idempotent: re-running over already-renamed rows finds zero matches
-- and no-ops. Fresh DBs match zero rows on first run.
UPDATE items
SET properties = jsonb_set(
  properties::jsonb,
  '{kind}',
  CASE (properties::jsonb)->>'kind'
    WHEN 'user-app-grant' THEN '"app"'::jsonb
    WHEN 'external-service-connector' THEN '"integration"'::jsonb
    WHEN 'tenant-share' THEN '"tenant"'::jsonb
  END
)::text
WHERE type = 'system.connection'
  AND (properties::jsonb)->>'kind' IN (
    'user-app-grant',
    'external-service-connector',
    'tenant-share'
  );
