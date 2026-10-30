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
  properties TEXT NOT NULL,
  capture_latitude REAL,
  capture_longitude REAL
);
CREATE INDEX IF NOT EXISTS items_type_created ON items (type, created_at);
CREATE INDEX IF NOT EXISTS items_type_updated ON items (type, updated_at);
CREATE INDEX IF NOT EXISTS items_type_occurred_at ON items (type, occurred_at);
-- A list's default order, newest created first with the id breaking ties,
-- read in index order rather than sorted, so a list of the whole copy needs
-- no sort that spills to disk. The second also narrows by state, which
-- every list does unless it asks for all states.
CREATE INDEX IF NOT EXISTS items_created ON items (created_at, id);
CREATE INDEX IF NOT EXISTS items_state_created ON items (state, created_at, id);
DROP INDEX IF EXISTS items_state;
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

-- The types an app declares for itself, as the server lists a type. What a
-- copy that has never reached a server checks its writes against beside the
-- types Marfa ships, and what a hydration registers on the instance.
-- Apart from `types`, which a hydration replaces whole.
CREATE TABLE IF NOT EXISTS declared_types (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
) WITHOUT ROWID;

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
  -- The drains in a row in which this write met an environmental failure. Not
  -- a refusal count: it is never held against the ceiling. An answer that is
  -- not an environmental failure, and every release, set it back to zero; a
  -- `429` leaves it as it was.
  environmental_streak INTEGER NOT NULL DEFAULT 0 CHECK (environmental_streak >= 0),
  -- When the current streak began, in milliseconds on the store's clock: the
  -- first failure of the run. Null while the streak is zero. A write is asked
  -- about only when this is five minutes back or more.
  environmental_since INTEGER,
  -- When the latest failure of the streak was met, on the same clock. A
  -- failure more than fifteen minutes after it, or after a time the clock has
  -- not reached, begins a new run instead of adding to this one.
  environmental_last INTEGER,
  -- A JSON `{"status": ..., "text": ...}`: the last answer the server gave the
  -- write that was no answer to it, a `429` included, `status` null where
  -- nothing answered and `text` null where the body was not text. A failure
  -- that was not the write's own, such as a credential renewal that failed,
  -- leaves it as it was.
  last_failure TEXT,
  -- The number of the write's last send: one past the highest number any write
  -- holds, taken when it is sent. Null for a write never sent. A drain tests a
  -- stuck write with the write sent least recently, the lowest number, a null
  -- first. A number rather than a time, so a clock set back reorders nothing.
  last_sent_seq INTEGER,
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
  -- A file item's blob, as its item named it when the file was last written
  -- or sent: `content_hash` is no blob hash, and once the file is gone only
  -- this tells whether another device changed its bytes. Null for a document.
  blob TEXT,
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
  missing_since TEXT NOT NULL,
  -- Why a sweep past the grace kept the file's binding: `arriving`, until the
  -- folder the file moved to takes it, or `unsure`, with `reason`, until a
  -- move can be told. A pull writes no file over either.
  kept TEXT CHECK (kept IN ('arriving', 'unsure')),
  reason TEXT
) WITHOUT ROWID;

-- What each link and embed in a body written through this copy names: the
-- item it resolved to, by which its edge is still known as the body's once
-- that item is renamed, or why it names none yet, so it is reported and
-- asked again. For a body written elsewhere, the item each link names is
-- recorded just before something it is read by changes. A folder keeps its
-- own record of what each file showed, in `folder_files`.
CREATE TABLE IF NOT EXISTS body_names (
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'embed')),
  -- As the body carries it: a link's text inside `[[ ]]`, or a whole embed.
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('resolved', 'pending', 'missing', 'ambiguous', 'unanswered', 'refused')
  ),
  other_id TEXT,
  reason TEXT,
  -- How many items the copy held that the name names when the server last
  -- answered it, so it is asked again only once that changes.
  held INTEGER,
  -- The write that left the body carrying it, which an edge made from it
  -- waits on while it is unanswered; none for a body written elsewhere.
  write_id TEXT,
  PRIMARY KEY (item_id, kind, text)
) WITHOUT ROWID;

-- The edge writes a body made, so their answer is read back onto the body:
-- a duplicate is the edge standing already, any other refusal is reported.
CREATE TABLE IF NOT EXISTS body_edges (
  write_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'embed')),
  other_id TEXT NOT NULL,
  -- The body's write it was read from, whose answer says whether that body
  -- is the item's.
  body_write TEXT
) WITHOUT ROWID;

-- An edit based on an earlier version, whose body is read once it is
-- answered, against the body the copy held when it was made.
CREATE TABLE IF NOT EXISTS body_checks (
  write_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  body TEXT NOT NULL
) WITHOUT ROWID;

-- The rows the body rule pinned to hold what a link or an embed names, let
-- go once no `references` edge reaches them and no `attached-to` edge leaves
-- them. A pin asked for again leaves this.
CREATE TABLE IF NOT EXISTS body_pins (
  item_id TEXT PRIMARY KEY
) WITHOUT ROWID;

-- The bytes the file cache keeps for files attached to items, by the hex of
-- their hash, with why the last fetch left them unheld. Kept in the
-- transaction that makes or ends an attachment, and only added to while the
-- copy is not whole, so a trim never takes bytes an attachment not yet
-- arrived again still names.
CREATE TABLE IF NOT EXISTS attachment_bytes (
  hex TEXT PRIMARY KEY,
  miss TEXT
) WITHOUT ROWID;

-- `copy_revision` in `meta` moves with every change to a row a folder's pull
-- reads, whoever made it: a catch-up, a hydration, a write laid over the copy
-- before the server answers, a drain's answer or its rollback. A folder watch
-- skips the pull of a pass that finds it where the last pull began. Triggers,
-- because neither the event cursor nor `PRAGMA data_version` sees a change
-- made on the reader's own connection. None on a folder's own tables, which
-- the watch compares by their content.
CREATE TRIGGER IF NOT EXISTS types_revise_insert AFTER INSERT ON types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS types_revise_update AFTER UPDATE ON types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS types_revise_delete AFTER DELETE ON types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS edge_types_revise_insert AFTER INSERT ON edge_types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS edge_types_revise_update AFTER UPDATE ON edge_types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS edge_types_revise_delete AFTER DELETE ON edge_types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS declared_types_revise_insert AFTER INSERT ON declared_types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS declared_types_revise_update AFTER UPDATE ON declared_types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS declared_types_revise_delete AFTER DELETE ON declared_types BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS items_revise_insert AFTER INSERT ON items BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS items_revise_update AFTER UPDATE ON items BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS items_revise_delete AFTER DELETE ON items BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS edges_revise_insert AFTER INSERT ON edges BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS edges_revise_update AFTER UPDATE ON edges BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS edges_revise_delete AFTER DELETE ON edges BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS tags_revise_insert AFTER INSERT ON tags BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS tags_revise_update AFTER UPDATE ON tags BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS tags_revise_delete AFTER DELETE ON tags BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS pins_revise_insert AFTER INSERT ON pins BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS pins_revise_update AFTER UPDATE ON pins BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS pins_revise_delete AFTER DELETE ON pins BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS queue_revise_insert AFTER INSERT ON queue BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS queue_revise_update AFTER UPDATE ON queue BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER IF NOT EXISTS queue_revise_delete AFTER DELETE ON queue BEGIN
  INSERT INTO meta (key, value) VALUES ('copy_revision', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;

-- Each item a change to the copy touched, numbered by its latest change, so a
-- folder watch renders only the files a change since its last pull reaches.
-- The triggers on the tables `copy_revision` follows write it, for the same
-- reason. `''` stands for every item, for a change to the types that every
-- file is rendered by. One row an item, so it holds no more rows than the
-- copy has held items; a watch reads past its own number and deletes nothing,
-- since every folder's watch reads it.
CREATE TABLE IF NOT EXISTS copy_changes (
  item_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS copy_changes_seq ON copy_changes (seq);

CREATE TRIGGER IF NOT EXISTS types_change_insert AFTER INSERT ON types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS types_change_update AFTER UPDATE ON types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS types_change_delete AFTER DELETE ON types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS edge_types_change_insert AFTER INSERT ON edge_types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS edge_types_change_update AFTER UPDATE ON edge_types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS edge_types_change_delete AFTER DELETE ON edge_types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS declared_types_change_insert AFTER INSERT ON declared_types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS declared_types_change_update AFTER UPDATE ON declared_types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS declared_types_change_delete AFTER DELETE ON declared_types BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT '' AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS items_change_insert AFTER INSERT ON items BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT NEW.id AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS items_change_update AFTER UPDATE ON items BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.id AS id UNION SELECT NEW.id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS items_change_delete AFTER DELETE ON items BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.id AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS edges_change_insert AFTER INSERT ON edges BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT NEW.source_id AS id UNION SELECT NEW.target_id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS edges_change_update AFTER UPDATE ON edges BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.source_id AS id UNION SELECT OLD.target_id UNION SELECT NEW.source_id UNION SELECT NEW.target_id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS edges_change_delete AFTER DELETE ON edges BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.source_id AS id UNION SELECT OLD.target_id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS tags_change_insert AFTER INSERT ON tags BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT NEW.item_id AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS tags_change_update AFTER UPDATE ON tags BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.item_id AS id UNION SELECT NEW.item_id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS tags_change_delete AFTER DELETE ON tags BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.item_id AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS pins_change_insert AFTER INSERT ON pins BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT NEW.item_id AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS pins_change_update AFTER UPDATE ON pins BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.item_id AS id UNION SELECT NEW.item_id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS pins_change_delete AFTER DELETE ON pins BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.item_id AS id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS queue_change_insert AFTER INSERT ON queue BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT NEW.item_id AS id UNION SELECT NEW.target_id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS queue_change_update AFTER UPDATE ON queue BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.item_id AS id UNION SELECT OLD.target_id UNION SELECT NEW.item_id UNION SELECT NEW.target_id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS queue_change_delete AFTER DELETE ON queue BEGIN
  INSERT INTO copy_changes (item_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM copy_changes)
    FROM (SELECT OLD.item_id AS id UNION SELECT OLD.target_id) WHERE id IS NOT NULL
    ON CONFLICT (item_id) DO UPDATE SET seq = excluded.seq;
END;

-- Each edge a change to the copy touched, numbered by its latest change, so
-- an app rereads only the edges changed since it last read
-- (`Core::changes_since`). `copy_changes` names an edge's ends, not the edge,
-- and so cannot name an edge that has gone. A table of its own because a
-- store already holds `copy_changes` in its present shape. One row an edge;
-- opening the store deletes the rows of edges it no longer holds past the
-- latest changes it keeps, and records where (`store::prune_edge_changes`).
CREATE TABLE IF NOT EXISTS edge_changes (
  edge_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS edge_changes_seq ON edge_changes (seq);

CREATE TRIGGER IF NOT EXISTS edges_edge_change_insert AFTER INSERT ON edges BEGIN
  INSERT INTO edge_changes (edge_id, seq)
    VALUES (NEW.id, (SELECT coalesce(max(seq), 0) + 1 FROM edge_changes))
    ON CONFLICT (edge_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS edges_edge_change_update AFTER UPDATE ON edges BEGIN
  INSERT INTO edge_changes (edge_id, seq)
    SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM edge_changes)
    FROM (SELECT OLD.id AS id UNION SELECT NEW.id) WHERE id IS NOT NULL
    ON CONFLICT (edge_id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS edges_edge_change_delete AFTER DELETE ON edges BEGIN
  INSERT INTO edge_changes (edge_id, seq)
    VALUES (OLD.id, (SELECT coalesce(max(seq), 0) + 1 FROM edge_changes))
    ON CONFLICT (edge_id) DO UPDATE SET seq = excluded.seq;
END;
