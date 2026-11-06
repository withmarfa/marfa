//! The server's database. The tables the core's query, filter and search code
//! read (`types`, `edge_types`, `items`, `tags`, `edges`, `items_fts`) take
//! their shape from the core's own schema, replayed here without the working
//! copy's triggers and tables; the rest are the server's.

use rusqlite::Connection;

/// The core's tables a server shares, with every index on them.
const SHARED_TABLES: [&str; 6] = ["types", "edge_types", "items", "tags", "edges", "items_fts"];

/// The core's `meta` table, which its catalog reads look in for a held
/// catalog. Kept as the core declares it.
const META: &str = "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";

const SERVER: &str = "
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  sources TEXT NOT NULL,
  permissions TEXT NOT NULL,
  default_tier TEXT,
  type_permissions TEXT NOT NULL,
  edge_permissions TEXT NOT NULL,
  extension_permissions TEXT NOT NULL,
  metadata_permissions TEXT NOT NULL,
  profile_permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_live_source ON api_keys (source) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS item_versions (
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  item TEXT NOT NULL,
  tags TEXT NOT NULL,
  key_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, version)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS event_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  item_type TEXT,
  version INTEGER,
  source TEXT,
  key_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_target_kind ON audit_log (target_kind);
CREATE UNIQUE INDEX IF NOT EXISTS items_natural_key ON items (source, source_id)
  WHERE source_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS item_title_keys (
  item_id TEXT PRIMARY KEY NOT NULL,
  title_key TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items (id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_item_title_keys_key ON item_title_keys (title_key, item_id);
CREATE TABLE IF NOT EXISTS item_search_keys (
  seq INTEGER PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS item_search_keys_item_id_unique ON item_search_keys (item_id);
";

pub fn apply(conn: &Connection) -> rusqlite::Result<()> {
    let shared = shared_statements()?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let applied = (|| {
        for (name, sql) in &shared {
            let present: bool = conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = ?1)",
                [name],
                |row| row.get(0),
            )?;
            if !present {
                conn.execute_batch(sql)?;
            }
        }
        conn.execute_batch(META)?;
        conn.execute_batch(SERVER)
    })();
    match applied {
        Ok(()) => conn.execute_batch("COMMIT"),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// The core's statements for the shared tables and their indexes, tables
/// first, read back from a scratch database the core's schema built.
fn shared_statements() -> rusqlite::Result<Vec<(String, String)>> {
    let scratch = Connection::open_in_memory()?;
    scratch.execute_batch(META)?;
    scratch.execute_batch(marfa_core::server::SCHEMA)?;
    let mut statement = scratch.prepare(
        "SELECT name, sql FROM sqlite_master
         WHERE sql IS NOT NULL AND type IN ('table', 'index') AND tbl_name = ?1
         ORDER BY type = 'index', rowid",
    )?;
    let mut statements = Vec::new();
    for table in SHARED_TABLES {
        let rows = statement.query_map([table], |row| Ok((row.get(0)?, row.get(1)?)))?;
        for row in rows {
            statements.push(row?);
        }
    }
    Ok(statements)
}
