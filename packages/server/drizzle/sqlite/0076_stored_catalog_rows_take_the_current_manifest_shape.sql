-- The manifest contract dropped `runtime_compatibility` and moved its schema
-- major to 2. Every catalog row registered before that still carries the
-- field, in two places: the frozen `manifest` blob, and a denormalized copy
-- on the item for cheap listing. The registration path stopped writing
-- either, so new rows are already clean and only the old ones are stale.
--
-- Those rows only keep resolving because the validator tolerates both the
-- retired key and the old major. The tolerances are transitional and come
-- out once nothing depends on them, so the rows have to move first —
-- otherwise removing them breaks resolution for every installed connection,
-- and a credential mint fails closed when resolution fails.
--
-- The schema version is restamped to 2.0.0 on the rows this touches. That
-- is not rewriting history: `manifest_schema_version` records the shape of
-- the document, and once the retired key is gone the document IS the 2.x
-- shape. Leaving it at 1.x would describe the row as something it no longer
-- is. Every stored row was checked against the current schema before this
-- was written, and each one validates once the key is stripped, so none of
-- them lands here half-converted.
--
-- Idempotent: the guard matches only rows still carrying the key, so a
-- second run matches nothing.
UPDATE items
SET properties = jsonb_set(
  jsonb_remove(properties, '$.runtime_compatibility', '$.manifest.runtime_compatibility'),
  '$.manifest.manifest_schema_version',
  '2.0.0'
)
WHERE type = 'system.integration'
  AND (
    json_type(properties, '$.runtime_compatibility') IS NOT NULL
    OR json_type(properties, '$.manifest.runtime_compatibility') IS NOT NULL
  );
