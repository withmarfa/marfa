import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type LocalDb = ReturnType<typeof drizzle<typeof schema>>;
export type RawLocalDb = InstanceType<typeof Database>;

const DDL = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',
  properties TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source TEXT,
  source_id TEXT,
  origin TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER,
  device_id TEXT,
  parent_id TEXT,
  thread_id TEXT,
  capture_latitude REAL,
  capture_longitude REAL
);

CREATE INDEX IF NOT EXISTS idx_local_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_local_items_state ON items(state);
CREATE INDEX IF NOT EXISTS idx_local_items_thread_id ON items(thread_id);
CREATE INDEX IF NOT EXISTS idx_local_items_created_at ON items(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_items_source_dedup
  ON items(source, source_id) WHERE source IS NOT NULL;

CREATE TABLE IF NOT EXISTS metadata (
  item_id TEXT PRIMARY KEY,
  tags TEXT NOT NULL DEFAULT '[]',
  about TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS sync_state (
  table_name TEXT PRIMARY KEY,
  offset TEXT NOT NULL DEFAULT '-1',
  shape_handle TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mutation_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutation_queue_status ON mutation_queue(status);
`;

export function createLocalConnection(filePath: string): {
  db: LocalDb;
  raw: RawLocalDb;
  close: () => void;
} {
  if (filePath !== ":memory:") {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);

  const db = drizzle(sqlite, { schema });

  return {
    db,
    raw: sqlite,
    close: () => sqlite.close(),
  };
}
