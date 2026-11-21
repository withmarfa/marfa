-- SQLite cannot change a CHECK, so types is made again with the new origins.
CREATE TABLE types_next (
    id TEXT PRIMARY KEY,
    parent TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('platform', 'registered', 'plugin')),
    plugin_name TEXT,
    plugin_version TEXT,
    created_by TEXT CHECK (created_by IS NULL OR json_valid(created_by)),
    owner_icon TEXT,
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((origin = 'plugin') = (plugin_name IS NOT NULL)),
    CHECK ((plugin_name IS NULL) = (plugin_version IS NULL))
) STRICT, WITHOUT ROWID;

INSERT INTO types_next (id, parent, origin, created_by, owner_icon, definition, created_at, updated_at)
SELECT id, parent, CASE origin WHEN 'user' THEN 'registered' ELSE origin END,
       created_by, owner_icon, definition, created_at, updated_at
FROM types;

DROP TABLE types;
ALTER TABLE types_next RENAME TO types;

CREATE INDEX types_parent ON types (parent) WHERE parent IS NOT NULL;

CREATE TRIGGER backup_types_inserted AFTER INSERT ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER backup_types_updated AFTER UPDATE ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER backup_types_deleted AFTER DELETE ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

-- One row per installed plugin. Removing it leaves its types, which keep their provenance.
CREATE TABLE plugins (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    mark TEXT NOT NULL,
    maker TEXT NOT NULL,
    marfa TEXT NOT NULL,
    manifest TEXT NOT NULL CHECK (json_valid(manifest)),
    installed_at TEXT NOT NULL,
    installed_by TEXT CHECK (installed_by IS NULL OR json_valid(installed_by)),
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TRIGGER backup_plugins_inserted AFTER INSERT ON plugins BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER backup_plugins_updated AFTER UPDATE ON plugins BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER backup_plugins_deleted AFTER DELETE ON plugins BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
