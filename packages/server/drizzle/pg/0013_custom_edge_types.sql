-- Wave 2 PR 4 commit 17: custom edge-type registration (POST /edges/types).
-- Mirrors custom_types for item-type registration.

CREATE TABLE IF NOT EXISTS custom_edge_types (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  schema TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
