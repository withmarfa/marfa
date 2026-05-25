-- T-122: rename the in-tree sync integration manifest from withmarfa.sync-agent
-- to withmarfa.sync. The name lives in the `properties` JSON column (TEXT,
-- cast to jsonb for JSON ops) on system.integration items and on
-- system.connection items that reference the integration. UPDATE in
-- place to preserve integration + connection row identity; items synced
-- through these connections carry references to the connection id, so a
-- DELETE+reseed would create dangling references.
--
-- Idempotent: re-running over already-renamed rows finds zero matches
-- and no-ops. Fresh DBs match zero rows on first run. We rewrite both
-- the top-level `manifest_name` (the queried key on bootstrap +
-- connection lookups) and the embedded `manifest.name` snapshot inside
-- `properties.manifest` so the registration snapshot stays consistent
-- with the indexed key.
UPDATE items
SET properties = jsonb_set(
  jsonb_set(
    properties::jsonb,
    '{manifest_name}',
    '"withmarfa.sync"'::jsonb
  ),
  '{manifest,name}',
  '"withmarfa.sync"'::jsonb
)::text
WHERE type IN ('system.integration', 'system.connection')
  AND (properties::jsonb)->>'manifest_name' = 'withmarfa.sync-agent';
