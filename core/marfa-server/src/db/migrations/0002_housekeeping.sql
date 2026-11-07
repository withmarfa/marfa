-- The housekeeping scheduler's table, and what its jobs need of the others.

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

-- Set once an item leaves the bin, however it left, and never cleared: the
-- `feed-expiry` job leaves such an item alone for good.
ALTER TABLE items ADD COLUMN restored_at TEXT;

CREATE TRIGGER IF NOT EXISTS items_restored
AFTER UPDATE OF state ON items
WHEN OLD.state = 'trashed' AND NEW.state <> 'trashed'
BEGIN
    UPDATE items SET restored_at = NEW.updated_at WHERE seq = NEW.seq;
END;

CREATE INDEX IF NOT EXISTS items_feed_window ON items (type, created_at, id)
    WHERE tier = 'feed' AND state = 'active' AND restored_at IS NULL;

CREATE INDEX IF NOT EXISTS items_bin_age ON items (trashed_at)
    WHERE state = 'trashed';

CREATE INDEX IF NOT EXISTS idempotency_records_age ON idempotency_records (created_at);
