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
    trashed_by_name TEXT,
    trashed_with TEXT,
    trashed_with_type TEXT,
    went_with_hosts INTEGER NOT NULL DEFAULT 0 CHECK (went_with_hosts IN (0, 1)),
    -- Set once an item leaves the bin, however it left, and never cleared: the
    -- `feed-expiry` job leaves such an item alone for good.
    restored_at TEXT,
    -- Last, so a read of any other column stops short of a wide value.
    properties BLOB NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS items_natural_key
    ON items (source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS items_link ON items (type, link) WHERE link IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_title_key
    ON items (title_key, id) WHERE title_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_type_newest ON items (type, state, created_at, id);
CREATE INDEX IF NOT EXISTS items_source_newest ON items (source, type, state, created_at, id);
CREATE INDEX IF NOT EXISTS items_changed ON items (updated_at, id);
CREATE INDEX IF NOT EXISTS items_occurred ON items (occurred_at, id);
CREATE INDEX IF NOT EXISTS items_newest ON items (created_at, id);
CREATE INDEX IF NOT EXISTS items_bin ON items (created_at, id) WHERE state = 'trashed';
CREATE INDEX IF NOT EXISTS items_trashed_with ON items (trashed_with)
    WHERE trashed_with IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_feed_window ON items (type, created_at, id)
    WHERE tier = 'feed' AND state = 'active' AND restored_at IS NULL;
CREATE INDEX IF NOT EXISTS items_bin_age ON items (trashed_at)
    WHERE state = 'trashed';

CREATE TABLE IF NOT EXISTS edges (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL REFERENCES items (id),
    target_id TEXT NOT NULL REFERENCES items (id),
    edge_type TEXT NOT NULL,
    properties BLOB NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source_id, target_id, edge_type)
) STRICT;

CREATE INDEX IF NOT EXISTS edges_source ON edges (source_id, edge_type, created_at, id);
CREATE INDEX IF NOT EXISTS edges_target ON edges (target_id, edge_type, created_at, id);
CREATE INDEX IF NOT EXISTS edges_type ON edges (edge_type, created_at, id);
CREATE INDEX IF NOT EXISTS edges_newest ON edges (created_at, id);
CREATE INDEX IF NOT EXISTS edges_changed ON edges (updated_at, id);

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

CREATE INDEX IF NOT EXISTS idempotency_records_age ON idempotency_records (created_at);

CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    payload TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS housekeeping_jobs (
    name TEXT PRIMARY KEY,
    next_run_at TEXT NOT NULL,
    running_since TEXT,
    last_started_at TEXT,
    last_finished_at TEXT,
    last_outcome TEXT CHECK (last_outcome IN ('ok', 'error')),
    last_error TEXT,
    last_result TEXT
) STRICT, WITHOUT ROWID;

-- The text a search reads, by `items.seq`. A row in the bin holds no row here.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    title, body, description, name, extra, tags,
    tokenize = 'porter unicode61'
);

-- The rows whose indexed text a write may have changed. The item write function
-- empties this as its last step, in the same transaction, so a write cannot
-- leave the index behind by any path through it.
CREATE TABLE IF NOT EXISTS items_fts_pending (
    seq INTEGER PRIMARY KEY
) STRICT;

CREATE TRIGGER IF NOT EXISTS items_fts_inserted AFTER INSERT ON items BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (NEW.seq);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_updated AFTER UPDATE OF type, state, properties ON items
WHEN NEW.type IS NOT OLD.type OR NEW.state IS NOT OLD.state
    OR NEW.properties IS NOT OLD.properties
BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (NEW.seq);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_deleted AFTER DELETE ON items BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (OLD.seq);
END;
CREATE TRIGGER IF NOT EXISTS item_tags_fts_inserted AFTER INSERT ON item_tags BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (NEW.item_seq);
END;
CREATE TRIGGER IF NOT EXISTS item_tags_fts_deleted AFTER DELETE ON item_tags BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (OLD.item_seq);
END;
CREATE TRIGGER IF NOT EXISTS items_restored
AFTER UPDATE OF state ON items
WHEN OLD.state = 'trashed' AND NEW.state <> 'trashed'
BEGIN
    UPDATE items SET restored_at = NEW.updated_at WHERE seq = NEW.seq;
END;

-- The types whose searchable fields changed, each state's rows walked by `seq`
-- in pages, so a large type never holds the writer.
CREATE TABLE IF NOT EXISTS items_fts_stale (
    type TEXT NOT NULL,
    state TEXT NOT NULL,
    after_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (type, state)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS auth_user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS auth_account (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES auth_user (id) ON DELETE CASCADE,
    password TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

-- `token` holds a digest, never the cookie's value. `updated_at` is the last
-- recorded use.
CREATE TABLE IF NOT EXISTS auth_session (
    id TEXT PRIMARY KEY NOT NULL,
    token TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    remembered INTEGER NOT NULL DEFAULT 1,
    user_agent TEXT,
    ip_address TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS auth_session_user ON auth_session (user_id);

-- What leads to a claim. Every row holds a digest, and goes with the claim.
-- `expires_at` is in milliseconds, and a setup code has none.
CREATE TABLE IF NOT EXISTS setup_proof (
    digest TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('code', 'ticket', 'session')),
    generation TEXT NOT NULL,
    expires_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS rate_limit_windows (
    family TEXT NOT NULL,
    window_key TEXT NOT NULL,
    count INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (family, window_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS rate_limit_windows_expiry ON rate_limit_windows (expires_at);

-- What the OAuth server keeps. A secret is held only as a digest, and every
-- time is in milliseconds.

CREATE TABLE IF NOT EXISTS auth_oauth_client (
    client_id TEXT PRIMARY KEY NOT NULL,
    auth_method TEXT NOT NULL,
    secret_digest TEXT,
    application_type TEXT NOT NULL CHECK (application_type IN ('web', 'native')),
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL,
    response_types TEXT NOT NULL,
    scopes TEXT NOT NULL,
    client_name TEXT,
    client_uri TEXT,
    logo_uri TEXT,
    tos_uri TEXT,
    policy_uri TEXT,
    contacts TEXT NOT NULL,
    software_id TEXT,
    software_version TEXT,
    created_at INTEGER NOT NULL,
    offered_at INTEGER
) STRICT;

-- The clients that name themselves by a metadata document, and how long the
-- copy in `auth_oauth_client` may answer without a fetch.
CREATE TABLE IF NOT EXISTS auth_oauth_client_document (
    client_id TEXT PRIMARY KEY NOT NULL
        REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
    fetched_at INTEGER NOT NULL,
    fresh_until INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- One row per app and person, for as long as the client is kept. A withdrawn
-- consent keeps its row, so the same grant item comes back if the person
-- approves again.
CREATE TABLE IF NOT EXISTS auth_oauth_consent (
    client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id),
    user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    withdrawn_at INTEGER,
    PRIMARY KEY (client_id, user_id)
) STRICT, WITHOUT ROWID;

-- The redirect URIs a person approved. Only an approval adds a row, so a later
-- change to the client's own list reaches nothing here. `page_origin` is what
-- the URI allowed as a web page's origin when it was approved.
CREATE TABLE IF NOT EXISTS auth_oauth_consent_destination (
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    page_origin TEXT,
    PRIMARY KEY (client_id, user_id, redirect_uri),
    FOREIGN KEY (client_id, user_id)
        REFERENCES auth_oauth_consent (client_id, user_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- `session_id` names no table: the row outlives the session it asks about. A
-- spent row stays until `expires_at`, so a replay can end its `chain_id`.
CREATE TABLE IF NOT EXISTS auth_oauth_code (
    digest TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    challenge TEXT NOT NULL,
    resources TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    spent_at INTEGER,
    chain_id TEXT
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS auth_oauth_code_grant ON auth_oauth_code (client_id, user_id);

-- `client_id` holds no reference: a code outlives its client, so that the
-- approval page can say the client is gone.
CREATE TABLE IF NOT EXISTS auth_oauth_device_code (
    device_code TEXT PRIMARY KEY NOT NULL,
    user_code TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    destinations TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'spent')),
    user_id TEXT REFERENCES auth_user (id) ON DELETE CASCADE,
    interval_seconds INTEGER NOT NULL,
    last_polled_at INTEGER,
    expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS auth_oauth_device_code_client ON auth_oauth_device_code (client_id);

-- `chain_id` is what one authorization led to, through every rotation.
CREATE TABLE IF NOT EXISTS auth_oauth_access_token (
    id TEXT PRIMARY KEY NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id),
    user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
    chain_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    audience TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS auth_oauth_access_token_chain ON auth_oauth_access_token (chain_id);
CREATE INDEX IF NOT EXISTS auth_oauth_access_token_grant ON auth_oauth_access_token (client_id, user_id);

-- A rotated token stays until it would have expired, so that its replay is
-- told from a token nobody issued.
CREATE TABLE IF NOT EXISTS auth_oauth_refresh_token (
    id TEXT PRIMARY KEY NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id),
    user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
    chain_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    audience TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    rotated_at INTEGER,
    ended_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS auth_oauth_refresh_token_chain ON auth_oauth_refresh_token (chain_id);
CREATE INDEX IF NOT EXISTS auth_oauth_refresh_token_grant ON auth_oauth_refresh_token (client_id, user_id);

-- The owner's passkeys. `credential` is the verifier's record of one, as JSON,
-- and `host` the relying party it was made for, which is the only one it can
-- answer.
CREATE TABLE IF NOT EXISTS auth_passkey (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    name TEXT,
    credential TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS auth_passkey_user ON auth_passkey (user_id);

-- A ceremony under way. The browser holds a token and this table its digest,
-- so a copy of the database starts nothing. A row goes at its first use.
-- `expires_at` is in milliseconds.
CREATE TABLE IF NOT EXISTS auth_passkey_challenge (
    digest TEXT PRIMARY KEY NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('add', 'prove')),
    origin TEXT NOT NULL,
    session_id TEXT,
    state TEXT NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS auth_passkey_challenge_expiry ON auth_passkey_challenge (expires_at);

-- A blob is bytes under the digest of their content. `hash` is `sha256:` and
-- 64 lowercase hex characters; `mime_type` is the first type recorded.
CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    recorded_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Where bytes can be kept. `locator` is a disk store's folder or an object
-- store's bucket and prefix.
CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('disk', 's3')),
    locator TEXT NOT NULL,
    attached_at TEXT NOT NULL,
    detached_at TEXT
) STRICT, WITHOUT ROWID;

-- A store holds the bytes of a blob only while a row here says so.
CREATE TABLE IF NOT EXISTS blob_copies (
    hash TEXT NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores (id),
    recorded_at TEXT NOT NULL,
    verified_at TEXT,
    PRIMARY KEY (hash, store_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS blob_copies_store ON blob_copies (store_id, verified_at);

-- Who uploaded a blob: an API key's id, or the grant id of an app's tokens.
CREATE TABLE IF NOT EXISTS blob_proofs (
    hash TEXT NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    holder TEXT NOT NULL,
    PRIMARY KEY (hash, holder)
) STRICT, WITHOUT ROWID;

-- Non-lending references retain bytes without granting access.
CREATE TABLE IF NOT EXISTS blob_references (
    hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('item', 'edge', 'extension', 'version', 'owner')),
    seq INTEGER NOT NULL,
    namespace TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    lends INTEGER NOT NULL CHECK (lends IN (0, 1)),
    item_type TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    PRIMARY KEY (hash, kind, seq, namespace, version)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS blob_references_row ON blob_references (kind, seq);
CREATE INDEX IF NOT EXISTS blob_lenders
    ON blob_references (hash, kind, item_type, edge_type, namespace) WHERE lends = 1;

CREATE TRIGGER IF NOT EXISTS blob_references_retyped AFTER UPDATE OF type ON items
WHEN NEW.type IS NOT OLD.type
BEGIN
    UPDATE blob_references SET item_type = NEW.type
    WHERE kind IN ('item', 'extension') AND seq = NEW.seq;
    UPDATE blob_references SET item_type = NEW.type
    WHERE kind = 'edge' AND seq IN (SELECT seq FROM edges WHERE source_id = NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS blob_references_edge_moved AFTER UPDATE OF source_id, edge_type ON edges
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.edge_type IS NOT OLD.edge_type
BEGIN
    UPDATE blob_references
    SET item_type = (SELECT type FROM items WHERE id = NEW.source_id), edge_type = NEW.edge_type
    WHERE kind = 'edge' AND seq = NEW.seq;
END;

-- Blobs that nothing references, and when a run first found each.
CREATE TABLE IF NOT EXISTS blob_orphans (
    hash TEXT PRIMARY KEY NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    reported_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Bytes a store still holds for a copy that left the copy record.
CREATE TABLE IF NOT EXISTS blob_pending_deletions (
    hash TEXT NOT NULL,
    store_id TEXT NOT NULL REFERENCES stores (id),
    queued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (hash, store_id)
) STRICT, WITHOUT ROWID;

-- The digest omits the `sha256:` prefix used by `blobs.hash`.
CREATE TABLE IF NOT EXISTS owner_picture (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
    updated_at TEXT NOT NULL
) STRICT;
