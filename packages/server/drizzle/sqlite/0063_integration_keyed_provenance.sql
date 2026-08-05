-- Provenance keys on the integration and the space rather than the
-- Connection, so uninstall-then-reinstall lands on the items already
-- there: the natural-key pair (source, source_id) survives the
-- Connection id changing. Rewrite rows stamped under the retired
-- connection-keyed shape by resolving each source's Connection to its
-- manifest name through integration_ref. Connections survive uninstall
-- as revoked items, so their corpora resolve too and merge with any
-- sibling install of the same integration. Runtime credentials'
-- item_source values are not rewritten: they are short-lived and the
-- next mint stamps the new shape.
UPDATE items
SET source = 'integration:' || (
  SELECT json_extract(ii.properties, '$.manifest_name')
  FROM items c
  JOIN items ii
    ON ii.id = json_extract(c.properties, '$.integration_ref')
   AND ii.type = 'system.integration'
  WHERE c.type = 'system.connection'
    AND 'integration:' || c.id = items.source
)
WHERE source LIKE 'integration:%'
  AND EXISTS (
    SELECT 1
    FROM items c
    JOIN items ii
      ON ii.id = json_extract(c.properties, '$.integration_ref')
     AND ii.type = 'system.integration'
    WHERE c.type = 'system.connection'
      AND 'integration:' || c.id = items.source
      AND json_extract(ii.properties, '$.manifest_name') IS NOT NULL
  );
