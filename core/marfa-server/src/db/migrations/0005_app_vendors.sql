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

-- Who minted each key: an app (an owner's key minted through it too, which
-- oauth_client_id leaves out), the owner, or, for a key made before this
-- column, no one where no record says. It replaces app_made.
ALTER TABLE api_keys ADD COLUMN made_by_client TEXT;
ALTER TABLE api_keys ADD COLUMN maker_unknown INTEGER NOT NULL DEFAULT 0
    CHECK (maker_unknown IN (0, 1));

-- '' stands for the owner. A grant's app is known from its consent or from
-- the grant records, which pair each grant with its client. A minting key's
-- own mint record names its maker, whether or not cleanup removed its row.
CREATE TEMP TABLE key_makers AS
WITH RECURSIVE
    grant_clients (grant_id, client) AS (
        SELECT grant_id, client_id FROM oauth_consents
        UNION
        SELECT json_extract(details, '$.grant_item_id'), resource_id
        FROM audit_log
        WHERE resource_type = 'oauth_grant' AND resource_id IS NOT NULL
            AND json_type(details, '$.grant_item_id') = 'text'
    ),
    grant_client (grant_id, client) AS (
        SELECT grant_id, min(client) FROM grant_clients
        GROUP BY grant_id HAVING count(DISTINCT client) = 1
    ),
    mints (id, kind, actor) AS (
        SELECT resource_id, json_extract(actor, '$.kind'), json_extract(actor, '$.id')
        FROM audit_log
        WHERE action = 'key.create' AND resource_id IS NOT NULL
    ),
    made (id, maker) AS (
        SELECT id, '' FROM mints WHERE kind IN ('local', 'browser', 'server')
        UNION
        SELECT m.id, g.client FROM mints AS m
        JOIN grant_client AS g ON g.grant_id = m.actor
        WHERE m.kind = 'app'
        UNION
        SELECT m.id, k.oauth_client_id FROM mints AS m
        JOIN api_keys AS k ON k.id = m.actor
        WHERE m.kind = 'key' AND k.oauth_client_id IS NOT NULL
        UNION
        SELECT m.id, d.maker FROM mints AS m
        JOIN made AS d ON d.id = m.actor
        WHERE m.kind = 'key' AND NOT EXISTS (
            SELECT 1 FROM api_keys AS k
            WHERE k.id = m.actor AND k.oauth_client_id IS NOT NULL
        )
    )
SELECT id, min(maker) AS maker FROM made
GROUP BY id HAVING count(DISTINCT maker) = 1;

UPDATE api_keys SET made_by_client = oauth_client_id WHERE oauth_client_id IS NOT NULL;

UPDATE api_keys
SET made_by_client = (SELECT nullif(maker, '') FROM temp.key_makers WHERE id = api_keys.id)
WHERE oauth_client_id IS NULL;

-- Where no record names a maker, app_made, which 0004 set, says whether the owner made the key.
UPDATE api_keys SET maker_unknown = 1
WHERE oauth_client_id IS NULL AND app_made = 1
    AND id NOT IN (SELECT id FROM temp.key_makers);

DROP TABLE temp.key_makers;

ALTER TABLE api_keys DROP COLUMN app_made;

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
            WHEN 'key' THEN CASE WHEN k.id IS NULL OR k.maker_unknown = 1 THEN ''
                ELSE k.made_by_client END
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
