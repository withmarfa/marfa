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
    -- The later of `updated_at` and the last change to the item's rows.
    last_activity_at TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS items_activity ON items (last_activity_at, id);

-- One per table of an item that has held a row, kept by the row write. AUTOINCREMENT: a purged
-- item's rows outlive its summary until housekeeping removes them, keyed by its seq.
CREATE TABLE IF NOT EXISTS table_summaries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    item_seq INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    last_batch TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    -- The `<kind>:<column>` every row's `ord` is the key of; NULL while none or while it is rebuilt.
    ordered_by TEXT,
    -- The searchable columns `rows_fts` holds every row by, joined by commas; NULL while rebuilt.
    searched_by TEXT,
    -- The table's `rows_fts` entries and their length in tokens, kept by `row_search`'s triggers.
    indexed INTEGER NOT NULL DEFAULT 0 CHECK (indexed >= 0),
    indexed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (indexed_tokens >= 0),
    UNIQUE (item_seq, table_name)
) STRICT;

-- `refs` holds, by column, each value written as an item's id, withheld whatever the column
-- becomes. Keep values last so key reads stop before them.
CREATE TABLE IF NOT EXISTS table_rows (
    table_seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ord ANY,
    -- Undo restores the prior mark so earlier batches remain undoable.
    batch INTEGER NOT NULL,
    refs BLOB,
    body BLOB NOT NULL,
    PRIMARY KEY (table_seq, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS table_rows_updated ON table_rows (table_seq, updated_at);
CREATE INDEX IF NOT EXISTS table_rows_ordered ON table_rows (table_seq, ord) WHERE ord IS NOT NULL;

-- Tables whose `ord` `table-row-cleanup` brings to `target` (NULL clears it), a page at a time.
CREATE TABLE IF NOT EXISTS table_rows_reordering (
    table_seq INTEGER PRIMARY KEY,
    target TEXT,
    after_id TEXT
) STRICT;

-- Column c<n> holds the nth searchable column in name order; rowid is row_search.seq.
CREATE VIRTUAL TABLE IF NOT EXISTS rows_fts USING fts5(
    c0, c1, c2, c3, c4, c5, c6, c7,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS row_search (
    seq INTEGER PRIMARY KEY,
    table_seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
    UNIQUE (table_seq, id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS row_search_added AFTER INSERT ON row_search BEGIN
    UPDATE table_summaries SET indexed = indexed + 1, indexed_tokens = indexed_tokens + NEW.tokens
    WHERE seq = NEW.table_seq;
END;
CREATE TRIGGER IF NOT EXISTS row_search_removed AFTER DELETE ON row_search BEGIN
    UPDATE table_summaries SET indexed = indexed - 1, indexed_tokens = indexed_tokens - OLD.tokens
    WHERE seq = OLD.table_seq;
END;
CREATE TRIGGER IF NOT EXISTS row_search_resized AFTER UPDATE OF tokens ON row_search BEGIN
    UPDATE table_summaries SET indexed_tokens = indexed_tokens - OLD.tokens + NEW.tokens
    WHERE seq = NEW.table_seq;
END;

-- Tables whose `rows_fts` entries `table-row-cleanup` brings to `target`, a page at a time.
CREATE TABLE IF NOT EXISTS table_rows_reindexing (
    table_seq INTEGER PRIMARY KEY,
    target TEXT NOT NULL,
    after_id TEXT
) STRICT;

-- Never reuse a sequence, so a change left without its batch never joins a new one.
CREATE TABLE IF NOT EXISTS row_batches (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    table_seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    rows INTEGER NOT NULL CHECK (rows >= 0),
    undoes TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS row_batches_table ON row_batches (table_seq, seq);

-- A missing before or after mark means the row did not exist then.
CREATE TABLE IF NOT EXISTS row_changes (
    batch INTEGER NOT NULL,
    id TEXT NOT NULL,
    before_batch INTEGER,
    after_batch INTEGER,
    refs BLOB,
    body BLOB,
    after_refs BLOB,
    PRIMARY KEY (batch, id)
) STRICT, WITHOUT ROWID;

-- Tables of purged items whose rows or log `table-row-cleanup` has still to remove.
CREATE TABLE IF NOT EXISTS table_rows_purging (
    table_seq INTEGER PRIMARY KEY
) STRICT;

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

CREATE INDEX IF NOT EXISTS item_versions_id ON item_versions (id);

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
    contract INTEGER NOT NULL,
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
    payload TEXT NOT NULL,
    fanout INTEGER NOT NULL CHECK (fanout IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS housekeeping_jobs (
    name TEXT PRIMARY KEY,
    next_run_at TEXT NOT NULL,
    wake_requested INTEGER NOT NULL DEFAULT 0 CHECK (wake_requested IN (0, 1)),
    running_since TEXT,
    last_started_at TEXT,
    last_finished_at TEXT,
    last_outcome TEXT CHECK (last_outcome IN ('ok', 'error')),
    last_error TEXT,
    last_result TEXT
) STRICT, WITHOUT ROWID;

-- A bulk action or type move. `processed` is the checkpoint: it commits with the chunk it counts.
CREATE TABLE IF NOT EXISTS bulk_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    action TEXT NOT NULL,
    input TEXT NOT NULL CHECK (json_valid(input)),
    key_id TEXT,
    grant_id TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('queued', 'in_progress', 'completed', 'failed', 'canceled')),
    matched INTEGER NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0,
    errored INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    CHECK ((key_id IS NULL) <> (grant_id IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS bulk_jobs_open ON bulk_jobs (status)
    WHERE status IN ('queued', 'in_progress');
CREATE INDEX IF NOT EXISTS bulk_jobs_finished ON bulk_jobs (finished_at)
    WHERE finished_at IS NOT NULL;

-- The items a job matched when it was queued, in the order it takes them, each with the
-- version and state it was matched at: a job writes an item only as it was then.
CREATE TABLE IF NOT EXISTS bulk_job_items (
    job_id TEXT NOT NULL REFERENCES bulk_jobs (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (job_id, position)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS bulk_job_notes (
    job_id TEXT NOT NULL REFERENCES bulk_jobs (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('changed', 'error', 'carried', 'blob')),
    name TEXT NOT NULL,
    body TEXT CHECK (body IS NULL OR json_valid(body)),
    UNIQUE (job_id, kind, name)
) STRICT;

-- The text a search reads, by `items.seq`. A row in the bin holds no row here.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    title, body, description, name, extra, tags,
    tokenize = 'porter unicode61'
);

-- Each `items_fts` entry's length in tokens, summed by type and source in `items_fts_totals`.
CREATE TABLE IF NOT EXISTS items_fts_sizes (
    seq INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    tokens INTEGER NOT NULL CHECK (tokens >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS items_fts_totals (
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    entries INTEGER NOT NULL CHECK (entries >= 0),
    tokens INTEGER NOT NULL CHECK (tokens >= 0),
    PRIMARY KEY (type, source)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS items_fts_sized AFTER INSERT ON items_fts_sizes BEGIN
    INSERT INTO items_fts_totals (type, source, entries, tokens)
    VALUES (NEW.type, NEW.source, 1, NEW.tokens)
    ON CONFLICT (type, source) DO UPDATE
    SET entries = entries + 1, tokens = tokens + excluded.tokens;
END;
CREATE TRIGGER IF NOT EXISTS items_fts_unsized AFTER DELETE ON items_fts_sizes BEGIN
    UPDATE items_fts_totals SET entries = entries - 1, tokens = tokens - OLD.tokens
    WHERE type = OLD.type AND source = OLD.source;
END;
CREATE TRIGGER IF NOT EXISTS items_fts_resized AFTER UPDATE ON items_fts_sizes BEGIN
    UPDATE items_fts_totals SET entries = entries - 1, tokens = tokens - OLD.tokens
    WHERE type = OLD.type AND source = OLD.source;
    INSERT INTO items_fts_totals (type, source, entries, tokens)
    VALUES (NEW.type, NEW.source, 1, NEW.tokens)
    ON CONFLICT (type, source) DO UPDATE
    SET entries = entries + 1, tokens = tokens + excluded.tokens;
END;
CREATE TRIGGER IF NOT EXISTS items_fts_moved AFTER UPDATE OF type, source ON items
WHEN NEW.type IS NOT OLD.type OR NEW.source IS NOT OLD.source
BEGIN
    UPDATE items_fts_sizes SET type = NEW.type, source = NEW.source WHERE seq = NEW.seq;
END;

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

-- The one owner. `password` holds the hash, never the password.
CREATE TABLE IF NOT EXISTS owner (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

-- `token` holds a digest, never the cookie's value. `updated_at` is the last
-- recorded use.
CREATE TABLE IF NOT EXISTS sign_ins (
    id TEXT PRIMARY KEY NOT NULL,
    token TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS sign_ins_owner ON sign_ins (owner_id);

-- What leads to a claim. Every row holds a digest, and goes with the claim.
-- A setup code has no `expires_at`.
CREATE TABLE IF NOT EXISTS setup_proof (
    digest TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('code', 'ticket', 'session')),
    generation TEXT NOT NULL,
    expires_at TEXT
) STRICT, WITHOUT ROWID;

-- Spent signatures expire at `expires_at`.
CREATE TABLE IF NOT EXISTS mcp_spent_confirmations (
    token TEXT PRIMARY KEY NOT NULL,
    credential TEXT NOT NULL,
    subject_digest TEXT NOT NULL,
    total INTEGER NOT NULL,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS mcp_spent_confirmations_expiry
    ON mcp_spent_confirmations (expires_at);

-- What the OAuth server keeps. A secret is held only as a digest.

CREATE TABLE IF NOT EXISTS oauth_clients (
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
    created_at TEXT NOT NULL,
    offered_at TEXT
) STRICT;

-- The clients that name themselves by a metadata document, and how long the
-- copy in `oauth_clients` may answer without a fetch.
CREATE TABLE IF NOT EXISTS oauth_client_documents (
    client_id TEXT PRIMARY KEY NOT NULL
        REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    fetched_at TEXT NOT NULL,
    fresh_until TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- One row per app and person, for as long as the client is kept. A withdrawn
-- consent keeps its row, so the same grant item comes back if the person
-- approves again.
CREATE TABLE IF NOT EXISTS oauth_consents (
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    withdrawn_at TEXT,
    PRIMARY KEY (client_id, owner_id)
) STRICT, WITHOUT ROWID;

-- starts_after excludes events committed before registration.
CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL,
    events TEXT NOT NULL CHECK (json_valid(events)),
    type_filter TEXT,
    secret TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    key_id TEXT REFERENCES api_keys (id) ON DELETE CASCADE,
    grant_id TEXT REFERENCES oauth_consents (grant_id) ON DELETE CASCADE,
    starts_after INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((key_id IS NULL) <> (grant_id IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS webhooks_key ON webhooks (key_id) WHERE key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhooks_grant ON webhooks (grant_id) WHERE grant_id IS NOT NULL;

-- Moves whenever its maker makes or deletes a webhook, so a confirmation can
-- tell the maker's webhooks changed and no one else's can move it.
CREATE TABLE IF NOT EXISTS webhook_turns (
    key_id TEXT REFERENCES api_keys (id) ON DELETE CASCADE,
    grant_id TEXT REFERENCES oauth_consents (grant_id) ON DELETE CASCADE,
    turns INTEGER NOT NULL,
    CHECK ((key_id IS NULL) <> (grant_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_turns_key ON webhook_turns (key_id) WHERE key_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_turns_grant ON webhook_turns (grant_id) WHERE grant_id IS NOT NULL;

-- Payloads outlive log expiry; cycle_attempt restarts on redelivery.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    webhook_id TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'dead_letter', 'canceled')),
    status_code INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    cycle_attempt INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    due_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (webhook_id, event_id),
    CHECK (payload IS NOT NULL OR status IN ('success', 'canceled'))
) STRICT;

CREATE INDEX IF NOT EXISTS webhook_deliveries_due
    ON webhook_deliveries (due_at, seq) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_newest ON webhook_deliveries (webhook_id, seq);
CREATE INDEX IF NOT EXISTS webhook_deliveries_settled
    ON webhook_deliveries (created_at) WHERE status <> 'pending';

-- A missing position is a scheduling fault.
CREATE TABLE IF NOT EXISTS webhook_position (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    event_id INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO webhook_position (id, event_id) VALUES (1, 0);

-- The redirect URIs a person approved. Only an approval adds a row, so a later
-- change to the client's own list reaches nothing here. `page_origin` is what
-- the URI allowed as a web page's origin when it was approved.
CREATE TABLE IF NOT EXISTS oauth_consent_destinations (
    client_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    page_origin TEXT,
    PRIMARY KEY (client_id, owner_id, redirect_uri),
    FOREIGN KEY (client_id, owner_id)
        REFERENCES oauth_consents (client_id, owner_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- `session_id` names no table: the row outlives the session it asks about. A
-- spent row stays until `expires_at`, so a replay can end its `chain_id`.
CREATE TABLE IF NOT EXISTS oauth_codes (
    digest TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    challenge TEXT NOT NULL,
    resources TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    spent_at TEXT,
    chain_id TEXT
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS oauth_codes_grant ON oauth_codes (client_id, owner_id);

-- `client_id` holds no reference: a code outlives its client, so that the
-- approval page can say the client is gone.
CREATE TABLE IF NOT EXISTS oauth_device_codes (
    device_code TEXT PRIMARY KEY NOT NULL,
    user_code TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    destinations TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'spent')),
    owner_id TEXT REFERENCES owner (id) ON DELETE CASCADE,
    interval_seconds INTEGER NOT NULL,
    last_polled_at TEXT,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS oauth_device_codes_client ON oauth_device_codes (client_id);

-- `chain_id` is what one authorization led to, through every rotation.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    chain_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    audience TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS oauth_access_tokens_chain ON oauth_access_tokens (chain_id);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_grant ON oauth_access_tokens (client_id, owner_id);

-- A rotated token stays until it would have expired, so that its replay is
-- told from a token nobody issued.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    chain_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    audience TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    rotated_at TEXT,
    ended_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_chain ON oauth_refresh_tokens (chain_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_grant ON oauth_refresh_tokens (client_id, owner_id);

-- The owner's passkeys. `credential` is the verifier's record of one, as JSON,
-- and `host` the relying party it was made for, which is the only one it can
-- answer.
CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    name TEXT,
    credential TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS passkeys_owner ON passkeys (owner_id);

-- A ceremony under way. The browser holds a token and this table its digest,
-- so a copy of the database starts nothing. A row goes at its first use.
CREATE TABLE IF NOT EXISTS passkey_challenges (
    digest TEXT PRIMARY KEY NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('add', 'prove')),
    origin TEXT NOT NULL,
    session_id TEXT,
    state TEXT NOT NULL,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS passkey_challenges_expiry ON passkey_challenges (expires_at);

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

-- A store holds the bytes of a blob only while a row here says so. `object`
-- names an object store's copy under its prefix, as the hash's hex and a name
-- of its own write, so no other write or deletion ever names it; it is empty
-- for a disk copy, whose file the hash names.
CREATE TABLE IF NOT EXISTS blob_copies (
    hash TEXT NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores (id),
    object TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    verified_at TEXT,
    PRIMARY KEY (hash, store_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS blob_copies_store ON blob_copies (store_id, verified_at);

-- Failure counts keep one uncopyable blob from monopolizing replication.
CREATE TABLE IF NOT EXISTS blob_copy_failures (
    hash TEXT NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores (id),
    failures INTEGER NOT NULL CHECK (failures > 0),
    PRIMARY KEY (hash, store_id)
) STRICT, WITHOUT ROWID;

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

-- Bytes a store may hold that no copy records: a copy that left the copy
-- record, or an object a write was sent to before it was recorded. `object` is
-- as in `blob_copies`.
CREATE TABLE IF NOT EXISTS blob_pending_deletions (
    hash TEXT NOT NULL,
    store_id TEXT NOT NULL REFERENCES stores (id),
    object TEXT NOT NULL DEFAULT '',
    queued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (hash, store_id, object)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS owner_picture (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    hash TEXT NOT NULL CHECK (length(hash) = 71),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
    updated_at TEXT NOT NULL
) STRICT;

-- Physical backups keep reports; portable archives exclude them. A report goes
-- with the key or app grant that made it.
CREATE TABLE IF NOT EXISTS folder_status (
    folder_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    key_id TEXT REFERENCES api_keys (id) ON DELETE CASCADE,
    grant_id TEXT REFERENCES oauth_consents (grant_id) ON DELETE CASCADE,
    sign_in_kind TEXT GENERATED ALWAYS AS (CASE WHEN key_id IS NULL THEN 'app' ELSE 'key' END) VIRTUAL,
    sign_in_id TEXT GENERATED ALWAYS AS (coalesce(key_id, grant_id)) VIRTUAL,
    sign_in_name TEXT NOT NULL,
    folder_store_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    received_at TEXT NOT NULL,
    last_success_at TEXT,
    pending_uploads INTEGER NOT NULL CHECK (pending_uploads >= 0),
    pending_downloads INTEGER NOT NULL CHECK (pending_downloads >= 0),
    paused_removals INTEGER NOT NULL CHECK (paused_removals >= 0),
    first_sync_waiting INTEGER NOT NULL CHECK (first_sync_waiting IN (0, 1)),
    problems TEXT NOT NULL CHECK (json_valid(problems)),
    CHECK ((key_id IS NULL) <> (grant_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS folder_status_copy
    ON folder_status (folder_id, sign_in_kind, sign_in_id, folder_store_id);
CREATE INDEX IF NOT EXISTS folder_status_key ON folder_status (key_id) WHERE key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS folder_status_grant ON folder_status (grant_id) WHERE grant_id IS NOT NULL;


-- A registration belongs to one key and outlives it; state, problems and agreements belong to the source.
CREATE TABLE IF NOT EXISTS connectors (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    key_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (length(source) > 0),
    name TEXT NOT NULL CHECK (length(name) > 0),
    description TEXT,
    read_only_types TEXT NOT NULL CHECK (json_valid(read_only_types)),
    registered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_heartbeat_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS connector_runs (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    summary TEXT,
    error TEXT,
    reported_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS connector_runs_newest
    ON connector_runs (connector_id, reported_at DESC, seq DESC);

CREATE TABLE IF NOT EXISTS connector_holds (
    connector_id TEXT PRIMARY KEY REFERENCES connectors (id) ON DELETE CASCADE,
    process TEXT NOT NULL,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS connector_states (
    source TEXT PRIMARY KEY CHECK (length(source) > 0),
    state TEXT NOT NULL CHECK (json_valid(state)),
    problems TEXT NOT NULL CHECK (json_valid(problems)),
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS connector_agreements (
    source TEXT NOT NULL CHECK (length(source) > 0),
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    waiting INTEGER NOT NULL CHECK (waiting IN (0, 1)),
    record TEXT NOT NULL CHECK (json_valid(record)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, item_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS connector_agreements_order
    ON connector_agreements (source, updated_at, item_id);
CREATE INDEX IF NOT EXISTS connector_agreements_item ON connector_agreements (item_id);

-- One row, and an integer by construction: a stored generation always reads.
CREATE TABLE IF NOT EXISTS read_only_generation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
) STRICT;

-- Raised when a key or a registration changes in a way that decides which items read as read only.
CREATE TRIGGER IF NOT EXISTS read_only_registered AFTER INSERT ON connectors
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_declared AFTER UPDATE OF read_only_types ON connectors
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_removed AFTER DELETE ON connectors
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_key_changed
AFTER UPDATE OF source, type_permissions, expires_at, revoked_at ON api_keys
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_key_removed AFTER DELETE ON api_keys
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_claim_changed AFTER INSERT ON api_key_sources
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER IF NOT EXISTS read_only_claim_removed AFTER DELETE ON api_key_sources
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;

CREATE TABLE IF NOT EXISTS enrichment_files (
    item_seq INTEGER NOT NULL,
    hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'read', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    reason TEXT CHECK (reason IN ('unsupported', 'encrypted', 'over_limit', 'ocr', 'missing')),
    signature TEXT NOT NULL DEFAULT '',
    -- The limit that stopped an over-limit file, and what it was then.
    capped_by TEXT CHECK (capped_by IN ('blob', 'inflated', 'memory', 'fixed')),
    cap INTEGER,
    -- A skipped file offered once more because a field a read fills was cleared; the refusal stays.
    refill INTEGER NOT NULL DEFAULT 0 CHECK (refill IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_seq, hash),
    CHECK (refill = 0 OR state = 'skipped'),
    CHECK ((state = 'skipped') = (reason IS NOT NULL)),
    CHECK ((reason IS 'over_limit') = (capped_by IS NOT NULL)),
    CHECK ((capped_by IS NULL) = (cap IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS enrichment_files_state ON enrichment_files (state, attempts);

-- Delay the wake to group a burst of writes into one run.
CREATE TRIGGER IF NOT EXISTS enrichment_files_referenced AFTER INSERT ON blob_references
WHEN NEW.kind = 'item' AND NEW.lends = 1
BEGIN
    INSERT OR REPLACE INTO enrichment_files (item_seq, hash, updated_at)
    VALUES (NEW.seq, NEW.hash, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    UPDATE housekeeping_jobs
    SET next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 seconds')
    WHERE name = 'enrichment-sweep'
      AND (running_since IS NOT NULL
           OR next_run_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 seconds'));
END;

-- Requeue files after their type, `mime_type` or `blob_ref` changes, or a fillable field is cleared.
CREATE TRIGGER IF NOT EXISTS enrichment_files_changed AFTER UPDATE OF type, properties ON items
WHEN NEW.properties ->> '$.blob_ref' IS NOT NULL AND (
    NEW.type IS NOT OLD.type
    OR NEW.properties ->> '$.blob_ref' IS NOT OLD.properties ->> '$.blob_ref'
    OR NEW.properties ->> '$.mime_type' IS NOT OLD.properties ->> '$.mime_type'
    OR (NEW.properties ->> '$.extracted_text' IS NULL AND OLD.properties ->> '$.extracted_text' IS NOT NULL)
    OR (NEW.properties ->> '$.width' IS NULL AND OLD.properties ->> '$.width' IS NOT NULL)
    OR (NEW.properties ->> '$.height' IS NULL AND OLD.properties ->> '$.height' IS NOT NULL)
    OR (NEW.properties ->> '$.duration' IS NULL AND OLD.properties ->> '$.duration' IS NOT NULL))
BEGIN
    INSERT INTO enrichment_files (item_seq, hash, updated_at)
    VALUES (NEW.seq, NEW.properties ->> '$.blob_ref', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (item_seq, hash) DO UPDATE
    SET state = CASE enrichment_files.state WHEN 'read' THEN 'waiting' ELSE enrichment_files.state END,
        attempts = 0,
        reason = CASE enrichment_files.state WHEN 'read' THEN NULL ELSE enrichment_files.reason END,
        signature = CASE enrichment_files.state WHEN 'read' THEN '' ELSE enrichment_files.signature END,
        refill = CASE enrichment_files.state WHEN 'skipped' THEN 1 ELSE 0 END,
        updated_at = excluded.updated_at
    WHERE enrichment_files.state IN ('read', 'skipped')
       OR (enrichment_files.state = 'waiting' AND enrichment_files.attempts > 0
           AND (NEW.type IS NOT OLD.type
                OR NEW.properties ->> '$.mime_type' IS NOT OLD.properties ->> '$.mime_type'));
    UPDATE housekeeping_jobs
    SET next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 seconds')
    WHERE name = 'enrichment-sweep'
      AND (running_since IS NOT NULL
           OR next_run_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 seconds'));
END;

CREATE INDEX IF NOT EXISTS enrichment_files_missing ON enrichment_files (hash) WHERE reason = 'missing';

-- A file left for want of a copy waits again once a copy is recorded or its store is attached.
CREATE TRIGGER IF NOT EXISTS enrichment_files_copy_recorded AFTER INSERT ON blob_copies
WHEN EXISTS (SELECT 1 FROM enrichment_files WHERE hash = NEW.hash AND reason = 'missing')
BEGIN
    UPDATE enrichment_files
    SET state = 'waiting', reason = NULL, refill = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE hash = NEW.hash AND reason = 'missing';
    UPDATE housekeeping_jobs
    SET next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 seconds')
    WHERE name = 'enrichment-sweep'
      AND (running_since IS NOT NULL
           OR next_run_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 seconds'));
END;

CREATE TRIGGER IF NOT EXISTS enrichment_files_store_attached AFTER UPDATE OF detached_at ON stores
WHEN OLD.detached_at IS NOT NULL AND NEW.detached_at IS NULL
BEGIN
    UPDATE enrichment_files
    SET state = 'waiting', reason = NULL, refill = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reason = 'missing'
      AND hash IN (SELECT hash FROM blob_copies WHERE store_id = NEW.id);
    UPDATE housekeeping_jobs
    SET next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 seconds')
    WHERE name = 'enrichment-sweep'
      AND (running_since IS NOT NULL
           OR next_run_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 seconds'));
END;

CREATE TRIGGER IF NOT EXISTS enrichment_files_unreferenced AFTER DELETE ON blob_references
WHEN OLD.kind = 'item'
BEGIN
    DELETE FROM enrichment_files WHERE item_seq = OLD.seq AND hash = OLD.hash;
END;

CREATE TABLE IF NOT EXISTS backup_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    changes INTEGER NOT NULL DEFAULT 0,
    backed_up INTEGER,
    last_backup TEXT,
    last_backup_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_failed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS backups (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    -- Since when, and in how many listings, the store has omitted it while a later backup was recorded.
    missing_since TEXT,
    omissions INTEGER NOT NULL DEFAULT 0 CHECK (omissions >= 0),
    UNIQUE (store_id, name)
) STRICT;

-- A NULL `last_seq` runs to the newest backup.
CREATE TABLE IF NOT EXISTS backup_files (
    store_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    first_seq INTEGER NOT NULL,
    last_seq INTEGER,
    PRIMARY KEY (store_id, hash)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS backup_items_inserted AFTER INSERT ON items BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_items_updated AFTER UPDATE ON items BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_items_deleted AFTER DELETE ON items BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_tags_inserted AFTER INSERT ON item_tags BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_tags_updated AFTER UPDATE ON item_tags BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_tags_deleted AFTER DELETE ON item_tags BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_extensions_inserted AFTER INSERT ON item_extensions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_extensions_updated AFTER UPDATE ON item_extensions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_extensions_deleted AFTER DELETE ON item_extensions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_versions_inserted AFTER INSERT ON item_versions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_versions_updated AFTER UPDATE ON item_versions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_item_versions_deleted AFTER DELETE ON item_versions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_edges_inserted AFTER INSERT ON edges BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_edges_updated AFTER UPDATE ON edges BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_edges_deleted AFTER DELETE ON edges BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_types_inserted AFTER INSERT ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_types_updated AFTER UPDATE ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_types_deleted AFTER DELETE ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_edge_types_inserted AFTER INSERT ON edge_types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_edge_types_updated AFTER UPDATE ON edge_types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_edge_types_deleted AFTER DELETE ON edge_types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_source_names_inserted AFTER INSERT ON source_names BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_source_names_updated AFTER UPDATE ON source_names BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_source_names_deleted AFTER DELETE ON source_names BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_connector_states_inserted AFTER INSERT ON connector_states BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_connector_states_updated AFTER UPDATE ON connector_states BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_connector_states_deleted AFTER DELETE ON connector_states BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_connector_agreements_inserted AFTER INSERT ON connector_agreements BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_connector_agreements_updated AFTER UPDATE ON connector_agreements BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_connector_agreements_deleted AFTER DELETE ON connector_agreements BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_settings_inserted AFTER INSERT ON settings
WHEN NEW.key <> 'health_probe'
BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_settings_updated AFTER UPDATE ON settings
WHEN NEW.key <> 'health_probe'
BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;

CREATE TRIGGER IF NOT EXISTS backup_settings_deleted AFTER DELETE ON settings
WHEN OLD.key <> 'health_probe'
BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
-- Source takeover changes the binding without deleting endpoints or deliveries.
CREATE TABLE IF NOT EXISTS inbound_sources (
    source TEXT PRIMARY KEY CHECK (length(source) > 0),
    connector_id TEXT NOT NULL UNIQUE REFERENCES connectors (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- The address is stored as a hash and its last four characters.
CREATE TABLE IF NOT EXISTS inbound_endpoints (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL REFERENCES inbound_sources (source) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    token_last4 TEXT NOT NULL CHECK (length(token_last4) = 4),
    label TEXT CHECK (label IS NULL OR length(label) > 0),
    duplicate_header TEXT,
    created_at TEXT NOT NULL,
    retired_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS inbound_endpoints_source ON inbound_endpoints (source, seq);

-- `charge` is the bytes the delivery holds against a registration's retained limits: body, headers and query.
CREATE TABLE IF NOT EXISTS inbound_deliveries (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    endpoint_id TEXT NOT NULL REFERENCES inbound_endpoints (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    received_at TEXT NOT NULL,
    method TEXT NOT NULL,
    query TEXT NOT NULL,
    headers TEXT NOT NULL CHECK (json_valid(headers)),
    size INTEGER NOT NULL CHECK (size >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    dedupe_key TEXT,
    charge INTEGER NOT NULL CHECK (charge >= size),
    handled_at TEXT,
    outcome TEXT CHECK (outcome IN ('processed', 'duplicate', 'rejected')),
    CHECK ((handled_at IS NULL) = (outcome IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS inbound_deliveries_order ON inbound_deliveries (source, received_at, seq);
CREATE INDEX IF NOT EXISTS inbound_deliveries_tally ON inbound_deliveries (source, handled_at, size, charge);
CREATE INDEX IF NOT EXISTS inbound_deliveries_endpoint ON inbound_deliveries (endpoint_id, received_at, seq);
CREATE INDEX IF NOT EXISTS inbound_deliveries_repeat
    ON inbound_deliveries (endpoint_id, dedupe_key, received_at, seq) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_deliveries_pending_age
    ON inbound_deliveries (received_at, seq) WHERE handled_at IS NULL;
CREATE INDEX IF NOT EXISTS inbound_deliveries_handled_age
    ON inbound_deliveries (handled_at, seq) WHERE handled_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbound_bodies (
    delivery_seq INTEGER PRIMARY KEY REFERENCES inbound_deliveries (seq) ON DELETE CASCADE,
    body BLOB NOT NULL
) STRICT;
