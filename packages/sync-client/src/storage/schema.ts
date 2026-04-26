/**
 * Bundled PGlite schema, version 1. Matches the SQL in
 * `migrations/0001_init.sql` literally; that file is the authoritative
 * version (also used in tests + the demo app), this constant is the
 * runtime-importable form so the bundle is self-contained without
 * filesystem access.
 *
 * The two categories of tables:
 *   - SYNCED — items / edges / metadata. Electric replicates here via
 *     `@electric-sql/pglite-sync`. The columns mirror the server's
 *     Postgres schema exactly.
 *   - LOCAL-ONLY — `_myme_mutation_queue`, `_myme_sync_state`,
 *     `_myme_schema_meta`. Owned by this package; never touched by
 *     Electric.
 */
export const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  library BOOLEAN NOT NULL DEFAULT false,
  properties TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source TEXT,
  source_id TEXT,
  origin TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER,
  device TEXT,
  capture_latitude DOUBLE PRECISION,
  capture_longitude DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_items_type ON items (type);
CREATE INDEX IF NOT EXISTS idx_items_state ON items (state);
CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items (updated_at);

CREATE TABLE IF NOT EXISTS metadata (
  item_id TEXT PRIMARY KEY,
  tags TEXT NOT NULL DEFAULT '[]',
  extensions TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target_id, edge_type);

CREATE TABLE IF NOT EXISTS _myme_mutation_queue (
  write_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  target_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mutation_queue_created_at
  ON _myme_mutation_queue (created_at);
CREATE INDEX IF NOT EXISTS idx_mutation_queue_target_id
  ON _myme_mutation_queue (target_id);
CREATE INDEX IF NOT EXISTS idx_mutation_queue_kind
  ON _myme_mutation_queue (kind);

CREATE TABLE IF NOT EXISTS _myme_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _myme_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Current schema version. Bumps with every forward migration. */
export const SCHEMA_VERSION = 1;
