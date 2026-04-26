-- @mymehq/sync-client local schema, version 1.
--
-- Two categories of tables:
--   * SYNCED — written by `@electric-sql/pglite-sync`. The columns must
--     match Myme server's Postgres schema exactly so Electric can
--     replicate without column mapping. Do not modify these except in
--     lockstep with the server.
--   * LOCAL ONLY — owned by the sync-client itself: mutation queue,
--     sync state, schema-version meta.

-- ── synced (Electric-owned) ───────────────────────────────────────────

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

-- ── local-only (sync-client-owned) ────────────────────────────────────

-- Durable mutation queue. Survives app restart.
-- Order: ascending by created_at (FIFO).
-- write_id == Idempotency-Key on the server; safe to replay.
CREATE TABLE IF NOT EXISTS _myme_mutation_queue (
  write_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,             -- JSON-encoded typed payload
  target_id TEXT,                    -- item / edge id if applicable
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  state TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'in_flight'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mutation_queue_created_at
  ON _myme_mutation_queue (created_at);
CREATE INDEX IF NOT EXISTS idx_mutation_queue_target_id
  ON _myme_mutation_queue (target_id);
CREATE INDEX IF NOT EXISTS idx_mutation_queue_kind
  ON _myme_mutation_queue (kind);

-- Sync state — last shape offsets, last_full_sync_at, etc.
CREATE TABLE IF NOT EXISTS _myme_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Schema version + type-registry hash. Bootstrapping checks this on
-- start; mismatched versions trigger migrations.
CREATE TABLE IF NOT EXISTS _myme_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
