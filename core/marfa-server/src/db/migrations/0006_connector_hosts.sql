-- A machine that runs connectors, and the key it holds once its one-time link is redeemed.
CREATE TABLE connector_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_id TEXT REFERENCES api_keys (id) ON DELETE SET NULL,
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX connector_hosts_key ON connector_hosts (key_id) WHERE key_id IS NOT NULL;

-- A host's one unredeemed link, kept only as the digest of its code.
CREATE TABLE connector_host_links (
    host_id TEXT PRIMARY KEY REFERENCES connector_hosts (id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- A plugin's connector: the source it holds, the host it is assigned to and the key that host
-- minted for it. Settings and the mapping extend it by plugin.
CREATE TABLE plugin_connectors (
    plugin TEXT PRIMARY KEY REFERENCES plugins (name) ON DELETE CASCADE,
    source TEXT NOT NULL UNIQUE,
    host_id TEXT REFERENCES connector_hosts (id) ON DELETE SET NULL,
    key_id TEXT REFERENCES api_keys (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX plugin_connectors_host ON plugin_connectors (host_id) WHERE host_id IS NOT NULL;

-- The host whose link minted a key: the host's own key and each connector key it minted.
ALTER TABLE api_keys ADD COLUMN made_by_host TEXT;

CREATE INDEX api_keys_made_by_host ON api_keys (made_by_host) WHERE made_by_host IS NOT NULL;
