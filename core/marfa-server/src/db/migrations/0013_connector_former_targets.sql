-- Each type a kind of a plugin's connector was mapped onto before, other than its target and
-- the connector's own types. A rewrite of the kind moves the connector's items from them.
CREATE TABLE IF NOT EXISTS connector_former_targets (
    plugin TEXT NOT NULL REFERENCES plugins (name) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    type_id TEXT NOT NULL,
    PRIMARY KEY (plugin, kind, type_id)
) STRICT, WITHOUT ROWID;
