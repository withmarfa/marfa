-- The (table, column) pairs a sorted page of rows reads from `table_row_keys`, with the kind of the
-- column the keys are made by. Every row write keeps a pair's keys from when it is added;
-- `filled_after` and `ready` track the walk that keys the rows already there.
CREATE TABLE IF NOT EXISTS table_sort_indexes (
    table_seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    filled_after TEXT NOT NULL DEFAULT '',
    ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
    PRIMARY KEY (table_seq, name)
) STRICT, WITHOUT ROWID;

-- Pairs no longer kept, whose keys are removed a page at a time.
CREATE TABLE IF NOT EXISTS table_sort_indexes_dropping (
    table_seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (table_seq, name)
) STRICT, WITHOUT ROWID;

-- Each row's sort key by each kept column; X'' is no key.
CREATE TABLE IF NOT EXISTS table_row_keys (
    table_seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    key ANY NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (table_seq, name, key, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS table_row_keys_of_row ON table_row_keys (table_seq, id);
