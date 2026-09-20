-- The local store, written to the contract in `conformance/spec/device.md`
-- and `queue-and-verdicts.md`. One file and no migrations: a store this
-- schema does not match is refused by name, for a person to discard and
-- hydrate again. What that buys is this file readable as a description of
-- what a device holds rather than the end of a chain of alterations.

-- `meta` is not declared here. `store::prepare` creates it on its own before
-- this file runs, because it reads the schema version out of it in order to
-- decide whether to run this file at all. A second declaration here would
-- never execute, and would fail silently the day the two disagreed.

CREATE TABLE IF NOT EXISTS types (
  id TEXT PRIMARY KEY,
  parent TEXT,
  label TEXT,
  title_field TEXT,
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
  device TEXT,
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

-- Keyed by rowid = items.seq: an FTS5 column cannot be indexed for a lookup,
-- so deleting by an item_id column would scan the whole index per write.
-- What goes in and what does not is `store::upsert_item`'s, and stated there.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5 (
  title,
  body,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- The queue. One row per write a caller made and the server has not yet
-- answered, and it outlives the process that made it (`queue-and-verdicts.md`
-- 1). Deliberately not a child of `items`: a re-hydration clears the working
-- copy (`device.md` 16) and the queue survives it intact
-- (`queue-and-verdicts.md` 30), so a foreign key here would delete the rows a
-- caller was told were queued.
CREATE TABLE IF NOT EXISTS queue (
  -- Insertion order is send order, and the drain reads it. A timestamp would
  -- tie under a fast caller and leave the order to the planner.
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  -- One of the closed set in `queue-and-verdicts.md` 32. The `CHECK` is here
  -- for the reason `verdict`'s is, eleven lines down: this file outlives
  -- every process that writes it, and a kind outside the set is a row no
  -- build can ever send. There is no refusal upstream of this to rely on.
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
  -- What the write is about. An item write names an item; an edge write names
  -- the edge and both of its endpoints, because an edge create can depend on
  -- two local creates that have not been answered (`queue-and-verdicts.md` 4
  -- and 33) and a single subject cannot say which.
  item_id TEXT,
  target_id TEXT,
  edge_id TEXT,
  -- The namespace an extension write is about, and the tag a tag write is
  -- about (`queue-and-verdicts.md` 32). Both also ride in `payload`; they are
  -- columns because a caller asking what is outstanding for one namespace or
  -- one tag is asking a question the payload cannot be searched for.
  namespace TEXT,
  tag TEXT,
  -- The version the write was based on (`queue-and-verdicts.md` 2). Required
  -- on an update and refused without one; optional on a create, which is
  -- conditional on it where it carries one.
  base_version INTEGER,
  -- Minted when the row is queued and never changed, so a write whose answer
  -- the device never saw is answered from the server's record rather than
  -- written twice (`queue-and-verdicts.md` 3).
  --
  -- `UNIQUE` because two rows sharing a key is the one thing the key exists
  -- to prevent: the server answers the second from the first's record, so a
  -- device that minted a duplicate would have one of its writes silently
  -- discarded and be told it succeeded.
  idempotency_key TEXT NOT NULL UNIQUE,
  -- The key this row was sent under before a caller released it
  -- (`queue-and-verdicts.md` 27). A released row goes out under a fresh key,
  -- because re-sending under the spent one is answered from the record and
  -- is the same refusal that blocked it; the spent key is kept so a late
  -- answer under it can still be recognized rather than read as an answer
  -- to the new attempt.
  spent_keys TEXT,
  -- The body, as the device will send it.
  payload TEXT NOT NULL,
  -- The queue rows this one waits for (`queue-and-verdicts.md` 4), as a JSON
  -- array of queue ids. A write naming a row whose create has not been
  -- answered is held rather than sent, because the server has no such row and
  -- would refuse it — and an edge can be waiting on two of them at once.
  --
  -- An array rather than a foreign key, deliberately. A key with `ON DELETE
  -- SET NULL` would make clearing an answered create silently release every
  -- write that was waiting on it, which is the same row state as a genuine
  -- release and tells nobody which it was; `RESTRICT` would refuse a caller
  -- clearing their own answered rows. Statement 24 says a held write is
  -- released by its dependency being answered, so the release is a decision
  -- the drain makes from the verdicts, not something a delete may make on
  -- its behalf.
  depends_on TEXT,
  -- One of the six (`queue-and-verdicts.md` 7), or null while unanswered.
  -- Null is the absence of an answer rather than a seventh verdict.
  --
  -- The `CHECK` is here rather than left to the code because this file
  -- outlives every process that writes it: a store carrying a verdict
  -- outside the set would be a store no later build could read correctly,
  -- and the closed set is the contract's rather than a convention.
  verdict TEXT CHECK (
    verdict IS NULL
    OR verdict IN ('accepted', 'merged', 'conflicted', 'refused', 'blocked', 'dead')
  ),
  -- Why a row is not going anywhere, in whichever vocabulary its verdict
  -- speaks: one of the five blocked reasons (`queue-and-verdicts.md` 26)
  -- under `blocked`, and the server's refusal code verbatim (12) under
  -- `refused`. A reader consults `verdict` to know which it is holding.
  --
  -- Not constrained, because half of its values are the server's and this
  -- file cannot hold a copy of the server's error vocabulary without going
  -- stale the first time the server adds one. The blocked set is checked
  -- where it is written.
  reason TEXT,
  -- The server's envelope, kept whole: a device reports a verdict and never
  -- acts on one (15), so what it reports has to be what it was told.
  answer TEXT,
  -- The sibling a `conflicted` verdict names (11).
  conflicted_copy_id TEXT,
  -- Refusals, not attempts (`queue-and-verdicts.md` 25). A device that could
  -- not ask has not been refused, so a week offline does not spend the
  -- ceiling.
  --
  -- The ceiling is five, and the `CHECK` is what fixes it in the one artifact
  -- that outlives the process. The contract says it is a number the contract
  -- fixes rather than configuration, and a constant in the binary alone would
  -- let two builds disagree about a store they both write.
  --
  -- **A release resets this to zero**, and the constraint is what requires
  -- it: a released row that is refused a sixth time would increment past the
  -- ceiling and abort its transaction rather than going `dead` a second time
  -- (`queue-and-verdicts.md` 27). The requirement lives here because this is
  -- where it is enforced, not in the code that has to satisfy it.
  refusals INTEGER NOT NULL DEFAULT 0 CHECK (refusals BETWEEN 0 AND 5),
  queued_at TEXT NOT NULL,
  answered_at TEXT
);
-- The drain reads unanswered rows in order.
CREATE INDEX IF NOT EXISTS queue_verdict_seq ON queue (verdict, seq);
-- A local read shows a row the device wrote and has not had answered
-- (`queue-and-verdicts.md` 31), which is a lookup by item.
CREATE INDEX IF NOT EXISTS queue_item ON queue (item_id);
-- No index on `depends_on`. It holds a JSON array, and releasing a held write
-- means finding every row whose array *contains* an answered id — which an
-- index on the serialized text cannot answer: `EXPLAIN QUERY PLAN` on a
-- containment query reports a scan, and the only shape that could ever search
-- is equality on the whole string, which misses every row waiting on two
-- creates. An index here would say the lookup was cheap without making it so.
