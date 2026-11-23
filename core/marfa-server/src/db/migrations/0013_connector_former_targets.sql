-- Each type a connector's kind was mapped onto before, other than the connector's own types.
CREATE TABLE IF NOT EXISTS connector_former_targets (
    plugin TEXT NOT NULL REFERENCES plugins (name) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    type_id TEXT NOT NULL,
    PRIMARY KEY (plugin, kind, type_id)
) STRICT, WITHOUT ROWID;
