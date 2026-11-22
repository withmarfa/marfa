-- The latest sign-in started for each plugin's connector. The state is kept only as its SHA-256,
-- and the PKCE verifier sealed, until the sign-in ends.
CREATE TABLE connector_sign_ins (
    plugin TEXT PRIMARY KEY REFERENCES plugin_connectors (plugin) ON DELETE CASCADE,
    id TEXT NOT NULL UNIQUE,
    install TEXT NOT NULL,
    state_hash TEXT NOT NULL UNIQUE,
    verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    return_to TEXT,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    exchanging_at TEXT,
    outcome TEXT CHECK (outcome IN ('signed_in', 'failed')),
    reason TEXT CHECK (reason IS NULL OR outcome = 'failed'),
    ended_at TEXT
) STRICT, WITHOUT ROWID;
