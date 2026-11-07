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
    label TEXT NOT NULL,
    source TEXT NOT NULL,
    permissions TEXT NOT NULL,
    type_permissions TEXT NOT NULL,
    edge_permissions TEXT NOT NULL,
    extension_permissions TEXT NOT NULL,
    metadata_permissions TEXT NOT NULL,
    profile_permissions TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
) STRICT, WITHOUT ROWID;
