-- The owner's passkeys. `credential` is what the verifying library keeps of
-- one, as JSON, and `host` the relying party it was made for, which is the
-- only one it can answer. Instants are stamps, as the contract shows them.
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
