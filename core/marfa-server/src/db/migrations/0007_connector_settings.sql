-- Each install of a plugin's connector, so a secret sealed for one never opens for a later one.
ALTER TABLE plugin_connectors ADD COLUMN id TEXT;

UPDATE plugin_connectors SET id = lower(hex(randomblob(16))) WHERE id IS NULL;

CREATE UNIQUE INDEX plugin_connectors_id ON plugin_connectors (id);

-- The value set for a setting of a plugin's connector: JSON, or sealed text for a secret.
CREATE TABLE plugin_connector_settings (
    plugin TEXT NOT NULL REFERENCES plugin_connectors (plugin) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (plugin, name)
) STRICT, WITHOUT ROWID;
