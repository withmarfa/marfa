-- Each `app.<vendor>` namespace and the OAuth client that claimed it by
-- registering the first type under it. No foreign key: a binding outlives the
-- client's row, and a client that names itself by a metadata document keeps
-- its client_id on any instance.
CREATE TABLE IF NOT EXISTS app_vendors (
    vendor TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS app_vendors_client ON app_vendors (client_id);

INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at)
SELECT
    substr(t.id, 1, instr(substr(t.id, 5), '.') + 3),
    COALESCE(c.client_id, k.oauth_client_id),
    t.created_at
FROM types AS t
LEFT JOIN oauth_consents AS c
    ON json_extract(t.created_by, '$.kind') = 'app'
    AND c.grant_id = json_extract(t.created_by, '$.id')
LEFT JOIN api_keys AS k
    ON json_extract(t.created_by, '$.kind') = 'key'
    AND k.id = json_extract(t.created_by, '$.id')
WHERE t.id GLOB 'app.*.*'
    AND t.created_by IS NOT NULL
    AND COALESCE(c.client_id, k.oauth_client_id) IS NOT NULL
ORDER BY t.created_at, t.id;
