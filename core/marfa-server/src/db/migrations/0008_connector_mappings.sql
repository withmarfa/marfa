-- The owner's mapping of each kind a plugin's connector brings. No row: every kind takes its
-- default. Removing the plugin removes it.
CREATE TABLE IF NOT EXISTS connector_mappings (
    plugin TEXT PRIMARY KEY NOT NULL REFERENCES plugins (name) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 1),
    kinds TEXT NOT NULL CHECK (json_valid(kinds) AND json_type(kinds) = 'object'),
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Each rewrite of the connector's existing items the owner asked for, until the connector clears
-- it. AUTOINCREMENT, so a number is never given again.
CREATE TABLE IF NOT EXISTS connector_rewrites (
    number INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin TEXT NOT NULL REFERENCES plugins (name) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 0),
    kinds TEXT NOT NULL CHECK (json_valid(kinds) AND json_type(kinds) = 'array'),
    requested_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS connector_rewrites_by_plugin ON connector_rewrites (plugin, number);

CREATE TRIGGER IF NOT EXISTS backup_connector_mappings_inserted AFTER INSERT ON connector_mappings BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_connector_mappings_updated AFTER UPDATE ON connector_mappings BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_connector_mappings_deleted AFTER DELETE ON connector_mappings BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

-- A mapping, and the connector a plugin's bundle names, decide what a connector's key may write,
-- and so which items read as read only.
CREATE TRIGGER IF NOT EXISTS read_only_mapping_added AFTER INSERT ON connector_mappings
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_mapping_changed AFTER UPDATE ON connector_mappings
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_mapping_removed AFTER DELETE ON connector_mappings
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_plugin_added AFTER INSERT ON plugins
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_plugin_changed AFTER UPDATE OF manifest ON plugins
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_plugin_removed AFTER DELETE ON plugins
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
