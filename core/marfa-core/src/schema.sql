-- `meta` is not declared here: `store::prepare` creates it before this file
-- runs, because it reads the schema version from it to decide whether to run
-- this file at all. A declaration here would never execute.

CREATE TABLE IF NOT EXISTS types (
  id TEXT PRIMARY KEY,
  parent TEXT,
  label TEXT,
  title_field TEXT,
  -- Copied out of `json` when the catalog is written, so a read need not parse it.
  thumbnail_field TEXT,
  json TEXT NOT NULL
);

-- Each row as `GET /edge-types` lists it.
CREATE TABLE IF NOT EXISTS edge_types (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  tier TEXT,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  properties TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_type_created ON items (type, created_at);
CREATE INDEX IF NOT EXISTS items_type_updated ON items (type, updated_at);
CREATE INDEX IF NOT EXISTS items_type_occurred_at ON items (type, occurred_at);
CREATE INDEX IF NOT EXISTS items_state ON items (state);
CREATE INDEX IF NOT EXISTS items_tier ON items (tier);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  properties TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_source ON edges (source_id, edge_type);
CREATE INDEX IF NOT EXISTS edges_target ON edges (target_id, edge_type);

CREATE TABLE IF NOT EXISTS tags (
  item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tags_tag ON tags (tag);

-- The server's row or edge beneath the writes still waiting on it, as the
-- copy last took it: the copy lays those writes over it, so it cannot say
-- afterwards what a refused one covered.
CREATE TABLE IF NOT EXISTS beneath (
  subject TEXT NOT NULL CHECK (subject IN ('item', 'edge')),
  id TEXT NOT NULL,
  row TEXT NOT NULL,
  PRIMARY KEY (subject, id)
) WITHOUT ROWID;

-- A refused write's subject whose read-back has not landed. Not a column of
-- `queue`: a refused row can be discarded while the copy still owes the read.
CREATE TABLE IF NOT EXISTS read_backs (
  subject TEXT NOT NULL CHECK (subject IN ('item', 'edge')),
  id TEXT NOT NULL,
  -- An edge is read through its source's listing of its type.
  source_id TEXT,
  edge_type TEXT,
  -- Whether a refused write owed here was a move, which lets the row go
  -- where the read lands outside the slice.
  moved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, id)
) WITHOUT ROWID;

-- Not a child of `items`: a hydration clears the copy and keeps the pins.
CREATE TABLE IF NOT EXISTS pins (
  item_id TEXT PRIMARY KEY
) WITHOUT ROWID;

-- Keyed by rowid = items.seq: an FTS5 column cannot be indexed for a lookup,
-- so deleting by an item_id column would scan the whole index per write.
-- The columns and the tokenizer are the server's, so a query matches the same
-- rows here as there (`search-and-filters.md`).
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5 (
  title,
  body,
  description,
  name,
  extra,
  tags,
  tokenize = 'porter unicode61'
);

-- Not a child of `items`: a hydration clears the copy and the queue survives
-- it, so a foreign key here would delete rows a caller was told were queued.
CREATE TABLE IF NOT EXISTS queue (
  -- Send order. A timestamp would tie under a fast caller.
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  -- The `CHECK`s on this table are here because the file outlives every
  -- process that writes it, so two builds cannot disagree about a store.
  kind TEXT NOT NULL CHECK (
    kind IN (
      'create_item',
      'update_item',
      'delete_item',
      'restore_item',
      'transition_item',
      'create_edge',
      'update_edge',
      'delete_edge',
      'replace_metadata',
      'merge_metadata',
      'add_tag',
      'remove_tag',
      'write_extension',
      'delete_extension',
      'upload_blob'
    )
  ),
  -- An edge write names both endpoints too: an edge create can wait on two
  -- unanswered local creates, which a single subject cannot say.
  item_id TEXT,
  target_id TEXT,
  edge_id TEXT,
  -- Also in `payload`; columns so outstanding writes can be looked up by them.
  namespace TEXT,
  tag TEXT,
  blob TEXT,
  base_version INTEGER,
  -- `UNIQUE` because the server answers a reused key from the first write's
  -- record: a duplicate would be silently discarded and reported as accepted.
  idempotency_key TEXT NOT NULL UNIQUE,
  -- Kept so a late answer under a spent key is recognized rather than read as
  -- an answer to the attempt under the fresh one.
  spent_keys TEXT,
  payload TEXT NOT NULL,
  -- Tells a refusal the server gave (terminal) from one the drain gave a row
  -- that never went out (releasable without writing twice). `depends_on`
  -- cannot: a server-refused row may carry one too.
  sent INTEGER NOT NULL DEFAULT 0,
  -- A JSON array of queue ids, not a foreign key: `ON DELETE SET NULL` would
  -- let clearing an answered create silently release its waiters, and
  -- `RESTRICT` would refuse a caller clearing their own answered rows. Release
  -- is the drain's decision from the verdicts.
  depends_on TEXT,
  -- Ordering only, apart from `depends_on` because a refusal of the write
  -- ahead is not a refusal of this one.
  follows TEXT,
  -- `{"properties": {...}}`: the copy's values this edit was made against.
  -- The copy cannot say afterwards, because it lays this edit over the row.
  read TEXT,
  verdict TEXT CHECK (
    verdict IS NULL
    OR verdict IN ('accepted', 'merged', 'conflicted', 'refused', 'blocked', 'dead')
  ),
  -- A blocked reason under `blocked`, the server's refusal code verbatim under
  -- `refused`. Not constrained, because the server's codes are an open set;
  -- the blocked reasons are checked when the row is read.
  reason TEXT,
  answer TEXT,
  conflicted_copy_id TEXT,
  -- A release must reset this to zero: a released row refused again would
  -- break the `CHECK` and abort its transaction rather than go `dead`.
  refusals INTEGER NOT NULL DEFAULT 0 CHECK (refusals BETWEEN 0 AND 5),
  queued_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS queue_verdict_seq ON queue (verdict, seq);
CREATE INDEX IF NOT EXISTS queue_item ON queue (item_id);
CREATE INDEX IF NOT EXISTS queue_edge ON queue (edge_id);
-- No index on `depends_on`: finding rows whose JSON array contains an id is a
-- scan whatever is indexed, and an index would only make it look cheap.

-- Here rather than beside the folder because the mapping, the journal and the
-- queue must change in one transaction.
CREATE TABLE IF NOT EXISTS folder_files (
  path TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  identity TEXT,
  content_hash TEXT NOT NULL,
  presentation TEXT,
  written_hash TEXT,
  links TEXT NOT NULL,
  edge_lines TEXT NOT NULL,
  edit_line INTEGER,
  held TEXT,
  own TEXT,
  writes TEXT NOT NULL DEFAULT '{}',
  seen_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS folder_files_item ON folder_files (item_id);

CREATE TABLE IF NOT EXISTS folder_stats (
  path TEXT PRIMARY KEY,
  stat TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS folder_journal (
  path TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  missing_since TEXT NOT NULL
) WITHOUT ROWID;
