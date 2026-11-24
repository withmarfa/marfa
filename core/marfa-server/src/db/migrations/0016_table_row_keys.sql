-- Each row's sort key by each column `table_summaries.keyed_by` names; X'' is no key.
CREATE TABLE IF NOT EXISTS table_row_keys (
    table_seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    key ANY NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (table_seq, name, key, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS table_row_keys_of_row ON table_row_keys (table_seq, id);

-- Tables whose keys `table-row-cleanup` brings to the columns their type declares now.
CREATE TABLE IF NOT EXISTS table_rows_rekeying (
    table_seq INTEGER PRIMARY KEY,
    after_id TEXT
) STRICT;

-- The `<kind>:<column>` entries every row holds keys for, joined by commas; NULL while rebuilt.
ALTER TABLE table_summaries ADD COLUMN keyed_by TEXT;

INSERT OR IGNORE INTO table_rows_rekeying (table_seq) SELECT seq FROM table_summaries;
