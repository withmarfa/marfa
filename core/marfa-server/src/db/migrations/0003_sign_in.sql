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
