CREATE TABLE IF NOT EXISTS instance (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL CHECK (length(label) > 0),
    source TEXT NOT NULL CHECK (length(source) > 0),
    default_tier TEXT NOT NULL DEFAULT 'library' CHECK (default_tier IN ('library', 'feed')),
    oauth_client_id TEXT,
    permissions TEXT NOT NULL CHECK (json_valid(permissions)),
    type_permissions TEXT NOT NULL CHECK (json_valid(type_permissions)),
    edge_permissions TEXT NOT NULL CHECK (json_valid(edge_permissions)),
    extension_permissions TEXT NOT NULL CHECK (json_valid(extension_permissions)),
    metadata_permissions TEXT NOT NULL CHECK (json_valid(metadata_permissions)),
    profile_permissions TEXT NOT NULL CHECK (json_valid(profile_permissions)),
    enforcement_override TEXT CHECK (
        enforcement_override IS NULL OR json_valid(enforcement_override)
    ),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_held_source
    ON api_keys (source) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS api_key_sources (
    key_id TEXT NOT NULL REFERENCES api_keys (id),
    source TEXT NOT NULL CHECK (length(source) > 0),
    position INTEGER NOT NULL,
    PRIMARY KEY (key_id, source)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS api_key_sources_source ON api_key_sources (source);

CREATE TABLE IF NOT EXISTS source_names (
    source TEXT PRIMARY KEY CHECK (length(source) > 0),
    name TEXT,
    mark TEXT,
    updated_at TEXT NOT NULL,
    CHECK (name IS NOT NULL OR mark IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    key_id TEXT,
    actor TEXT CHECK (actor IS NULL OR json_valid(actor)),
    action TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'data', 'settings', 'housekeeping')),
    resource_type TEXT,
    resource_id TEXT,
    client_ip TEXT,
    details TEXT CHECK (details IS NULL OR json_valid(details))
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS audit_log_newest ON audit_log (created_at, id);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log (action, created_at, id);
CREATE INDEX IF NOT EXISTS audit_log_resource
    ON audit_log (resource_type, resource_id, created_at, id);
