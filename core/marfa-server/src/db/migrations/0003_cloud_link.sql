-- The one link to Marfa Cloud. Secrets are sealed with the settings key, and
-- archives and backups carry none of this table.
CREATE TABLE IF NOT EXISTS cloud_link (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    link_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('linking', 'linked', 'failed', 'ended')),
    user_code TEXT NOT NULL,
    approval_url TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    interval_ms INTEGER NOT NULL CHECK (interval_ms >= 1000),
    started_at TEXT NOT NULL,
    poll_secret TEXT,
    sign_in_move TEXT NOT NULL
        CHECK (sign_in_move IN ('keep', 'authorized', 'waiting', 'done')),
    -- Set once the move is done; null where no sign-in address was stored.
    previous_sign_in_address TEXT,
    name TEXT,
    address TEXT,
    approved_at TEXT,
    linked_at TEXT,
    tunnel_token TEXT,
    link_credential TEXT,
    failure_reason TEXT
        CHECK (failure_reason IN ('denied', 'expired', 'refused', 'unlinked', 'unlinked_by_service')),
    failure_message TEXT,
    ended_at TEXT
) STRICT;

-- Links ended here that Marfa Cloud has not been told of yet. A link cancelled
-- while it waited for approval keeps its poll secret until it expires.
CREATE TABLE IF NOT EXISTS cloud_unlinks (
    link_id TEXT PRIMARY KEY NOT NULL,
    link_credential TEXT,
    poll_secret TEXT,
    expires_at TEXT NOT NULL,
    interval_ms INTEGER NOT NULL CHECK (interval_ms >= 1000),
    until_at TEXT NOT NULL,
    CHECK (link_credential IS NOT NULL OR poll_secret IS NOT NULL)
) STRICT, WITHOUT ROWID;
