-- PROVISIONAL. Written before the contract (the specification and its
-- fixtures) exists, so it mirrors what GET /items, GET /items/{id}/edges and
-- GET /events carry today and nothing more: no queue, no versions, no blobs.
-- When the contract lands this file is rewritten to it; nothing here is
-- migrated.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  properties TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_type_created ON items (type, created_at);
CREATE INDEX IF NOT EXISTS items_type_updated ON items (type, updated_at);
CREATE INDEX IF NOT EXISTS items_type_timestamp ON items (type, timestamp);
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
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5 (
  title,
  body,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
