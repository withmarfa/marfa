-- T-122: rename the in-tree sync integration manifest from mymehq.sync-agent
-- to mymehq.sync. The name lives in the `properties` JSON column on
-- system.integration and system.connection items. SQLite's JSON1
-- functions handle the in-place rewrite. UPDATE preserves row identity
-- so items referencing the connection id stay intact.
--
-- Idempotent: re-running over already-renamed rows finds zero matches
-- and no-ops. Fresh DBs match zero rows on first run. We rewrite both
-- the top-level `manifest_name` (the queried key on bootstrap +
-- connection lookups) and the embedded `manifest.name` snapshot inside
-- `properties.manifest` so the registration snapshot stays consistent
-- with the indexed key.
UPDATE items
SET properties = json_set(
  json_set(properties, '$.manifest_name', 'mymehq.sync'),
  '$.manifest.name', 'mymehq.sync'
)
WHERE type IN ('system.integration', 'system.connection')
  AND json_extract(properties, '$.manifest_name') = 'mymehq.sync-agent';
