-- Each `app.<vendor>` namespace and who holds it: the OAuth client that
-- registered the first type under it, or NULL while the owner holds it to
-- give to an app. No foreign key: a binding outlives the client's row, and a
-- client that names itself by a metadata document keeps its client_id on any
-- instance.
CREATE TABLE IF NOT EXISTS app_vendors (
    vendor TEXT PRIMARY KEY NOT NULL,
    client_id TEXT,
    claimed_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS app_vendors_client ON app_vendors (client_id);

CREATE TRIGGER IF NOT EXISTS backup_app_vendors_inserted AFTER INSERT ON app_vendors BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_app_vendors_updated AFTER UPDATE ON app_vendors BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_app_vendors_deleted AFTER DELETE ON app_vendors BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

-- The app a key was minted through, owner_key or not, which oauth_client_id
-- leaves out of an owner's key.
ALTER TABLE api_keys ADD COLUMN made_by_client TEXT;

UPDATE api_keys SET made_by_client = oauth_client_id WHERE oauth_client_id IS NOT NULL;

-- An owner's key minted through an app before this column, as far as the
-- audit log still names the minter.
WITH RECURSIVE minted (id, client) AS (
    SELECT a.resource_id, c.client_id
    FROM audit_log AS a
    JOIN oauth_consents AS c ON c.grant_id = json_extract(a.actor, '$.id')
    WHERE a.action = 'key.create' AND json_extract(a.actor, '$.kind') = 'app'
    UNION
    SELECT a.resource_id, k.oauth_client_id
    FROM audit_log AS a
    JOIN api_keys AS k ON k.id = json_extract(a.actor, '$.id')
    WHERE a.action = 'key.create' AND json_extract(a.actor, '$.kind') = 'key'
        AND k.oauth_client_id IS NOT NULL
    UNION
    SELECT a.resource_id, m.client
    FROM audit_log AS a
    JOIN minted AS m ON m.id = json_extract(a.actor, '$.id')
    WHERE a.action = 'key.create' AND json_extract(a.actor, '$.kind') = 'key'
)
UPDATE api_keys
SET made_by_client = (SELECT min(client) FROM minted WHERE minted.id = api_keys.id)
WHERE made_by_client IS NULL AND id IN (SELECT id FROM minted);

-- A vendor goes to an app only when that one known app made every type under
-- it; otherwise the owner holds it until they give it to an app. Keep in step
-- with `MAKERS` in app/vendors.rs, which a restore uses.
INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at)
SELECT
    vendor,
    CASE WHEN count(maker) = count(*) AND count(DISTINCT maker) = 1
        AND min(maker) <> '' THEN min(maker) END,
    min(made_at)
FROM (
    SELECT
        substr(t.id, 1, instr(substr(t.id, 5), '.') + 3) AS vendor,
        CASE json_extract(t.created_by, '$.kind')
            WHEN 'app' THEN coalesce(c.client_id, '')
            WHEN 'key' THEN CASE WHEN k.id IS NULL THEN '' ELSE k.made_by_client END
            WHEN 'local' THEN NULL
            WHEN 'browser' THEN NULL
            WHEN 'server' THEN NULL
            ELSE ''
        END AS maker,
        t.created_at AS made_at
    FROM types AS t
    LEFT JOIN oauth_consents AS c
        ON json_extract(t.created_by, '$.kind') = 'app'
        AND c.grant_id = json_extract(t.created_by, '$.id')
    LEFT JOIN api_keys AS k
        ON json_extract(t.created_by, '$.kind') = 'key'
        AND k.id = json_extract(t.created_by, '$.id')
    WHERE t.id GLOB 'app.*.*'
)
GROUP BY vendor;
