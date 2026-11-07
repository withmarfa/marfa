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

CREATE TABLE IF NOT EXISTS types (
    id TEXT PRIMARY KEY,
    parent TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('platform', 'user')),
    created_by TEXT CHECK (created_by IS NULL OR json_valid(created_by)),
    owner_icon TEXT,
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS types_parent ON types (parent) WHERE parent IS NOT NULL;

CREATE TABLE IF NOT EXISTS edge_types (
    id TEXT PRIMARY KEY,
    reverse_name TEXT,
    created_by TEXT CHECK (created_by IS NULL OR json_valid(created_by)),
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS edge_types_reverse_name
    ON edge_types (reverse_name) WHERE reverse_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS items (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'archived', 'trashed', 'revoked')),
    tier TEXT CHECK (tier IS NULL OR tier IN ('library', 'feed')),
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_id TEXT,
    properties BLOB NOT NULL,
    title_key TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    schema_version INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trashed_at TEXT,
    capture_latitude REAL,
    capture_longitude REAL,
    writer_kind TEXT,
    writer_id TEXT,
    writer_name TEXT,
    link TEXT CHECK (link IS NULL OR length(link) > 0),
    trashed_by_kind TEXT,
    trashed_by_id TEXT,
    trashed_by_name TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS items_natural_key
    ON items (source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS items_link ON items (type, link) WHERE link IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_title_key
    ON items (title_key, id) WHERE title_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_type_state ON items (type, state);
CREATE INDEX IF NOT EXISTS items_newest ON items (created_at, id);
CREATE INDEX IF NOT EXISTS items_bin ON items (created_at, id) WHERE state = 'trashed';

CREATE TABLE IF NOT EXISTS item_tags (
    item_seq INTEGER NOT NULL REFERENCES items (seq),
    tag TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (item_seq, tag)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS item_extensions (
    item_seq INTEGER NOT NULL REFERENCES items (seq),
    namespace TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (item_seq, namespace)
) STRICT;

CREATE TABLE IF NOT EXISTS item_versions (
    item_seq INTEGER NOT NULL REFERENCES items (seq),
    version INTEGER NOT NULL,
    id TEXT NOT NULL,
    properties BLOB NOT NULL,
    type TEXT NOT NULL,
    tier TEXT,
    occurred_at TEXT NOT NULL,
    source_id TEXT,
    writer_kind TEXT,
    writer_id TEXT,
    writer_name TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_seq, version)
) STRICT;

CREATE TABLE IF NOT EXISTS link_tombstones (
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    purged_at TEXT NOT NULL,
    settled_at TEXT NOT NULL,
    PRIMARY KEY (type, value)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS natural_key_tombstones (
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    purged_at TEXT NOT NULL,
    settled_at TEXT NOT NULL,
    PRIMARY KEY (type, source, source_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS natural_key_tombstones_key
    ON natural_key_tombstones (source, source_id);

CREATE TABLE IF NOT EXISTS idempotency_records (
    credential TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('in_flight', 'complete')),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    response_status INTEGER,
    response_content_type TEXT,
    response_body BLOB,
    requirements TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (credential, idempotency_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    payload TEXT NOT NULL
) STRICT;
