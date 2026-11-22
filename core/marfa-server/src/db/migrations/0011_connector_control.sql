-- The owner's choice to pause a plugin's connector, and when they last asked it to run now.
ALTER TABLE plugin_connectors ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));

ALTER TABLE plugin_connectors ADD COLUMN run_requested_at TEXT;

-- A mapping preview the owner asked for, until it expires. Its rowid orders previews made in one
-- millisecond.
CREATE TABLE connector_previews (
    id TEXT PRIMARY KEY,
    plugin TEXT NOT NULL REFERENCES plugin_connectors (plugin) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT,
    mapping TEXT CHECK (mapping IS NULL OR (json_valid(mapping) AND json_type(mapping) = 'object')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    error TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    answered_at TEXT
) STRICT;

CREATE INDEX connector_previews_by_plugin ON connector_previews (plugin, created_at);

CREATE INDEX connector_previews_by_expiry ON connector_previews (expires_at);
