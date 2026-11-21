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

-- A vendor goes to an app only when exactly one known app made its types;
-- where several apps, or an app no longer known, made them, the owner holds
-- it. A vendor only the owner made types under stays unheld. Keep in step
-- with `MAKERS` in app/vendors.rs, which a restore uses.
INSERT OR IGNORE INTO app_vendors (vendor, client_id, claimed_at)
SELECT
    vendor,
    CASE WHEN count(DISTINCT maker) = 1 AND min(maker) <> '' THEN min(maker) END,
    min(made_at)
FROM (
    SELECT
        substr(t.id, 1, instr(substr(t.id, 5), '.') + 3) AS vendor,
        CASE json_extract(t.created_by, '$.kind')
            WHEN 'app' THEN coalesce(c.client_id, '')
            WHEN 'key' THEN CASE WHEN k.id IS NULL THEN '' ELSE k.oauth_client_id END
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
WHERE maker IS NOT NULL
GROUP BY vendor;
