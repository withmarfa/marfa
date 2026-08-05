-- Provenance keys on the integration and the space rather than the
-- Connection, so uninstall-then-reinstall lands on the items already
-- there: the natural-key pair (source, source_id) survives the
-- Connection id changing. Rewrite rows stamped under the retired
-- connection-keyed shape by resolving each source's Connection to its
-- manifest name through integration_ref. Connections survive uninstall
-- as revoked items, so their corpora resolve too and merge with any
-- sibling install of the same integration — the adoption this keying
-- exists to deliver. Runtime credentials' item_source values are not
-- rewritten: they are short-lived and the next mint stamps the new
-- shape.
UPDATE items i
SET source = 'integration:' || (ii.properties->>'manifest_name')
FROM items c
JOIN items ii
  ON ii.id = (c.properties->>'integration_ref')
 AND ii.type = 'system.integration'
WHERE c.type = 'system.connection'
  AND i.source = 'integration:' || c.id
  AND ii.properties->>'manifest_name' IS NOT NULL;
