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

-- `session_id` names no table: the row outlives the session it asks about.
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
    expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS auth_oauth_code_grant ON auth_oauth_code (client_id, user_id);

CREATE TABLE IF NOT EXISTS auth_oauth_device_code (
    device_code TEXT PRIMARY KEY NOT NULL,
    user_code TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
    scopes TEXT NOT NULL,
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
