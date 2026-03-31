import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

// Raw SQL for tables that Drizzle cannot express (FTS5 virtual tables).
const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id,
  title,
  body,
  description,
  name,
  content='',
  tokenize='porter unicode61'
);
`;

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Opens a SQLite connection, enables WAL mode, creates all tables
 * (idempotent), and returns the Drizzle db instance.
 */
export function createConnection(sqlitePath: string): {
  db: DrizzleDb;
  close: () => void;
} {
  // Ensure the directory exists
  const dir = dirname(sqlitePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(sqlitePath);

  // Enable WAL for better concurrent read/write performance
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Create tables via raw SQL (idempotent — CREATE TABLE IF NOT EXISTS)
  sqlite.exec(`
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
      thread_id TEXT REFERENCES threads(id),
      capture_latitude REAL,
      capture_longitude REAL
    );

    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_state ON items(state);
    CREATE INDEX IF NOT EXISTS idx_items_thread_id ON items(thread_id);
    CREATE INDEX IF NOT EXISTS idx_items_parent_id ON items(parent_id);
    CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at);
    CREATE INDEX IF NOT EXISTS idx_items_timestamp ON items(timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_dedup
      ON items(source, source_id) WHERE source IS NOT NULL;

    CREATE TABLE IF NOT EXISTS metadata (
      item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      tags TEXT NOT NULL DEFAULT '[]',
      about TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      properties TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_versions_item_id ON versions(item_id);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      type_permissions TEXT NOT NULL DEFAULT '{"*":"write"}',
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_path TEXT NOT NULL
    );
  `);

  // Create FTS5 virtual table
  sqlite.exec(CREATE_FTS);

  const db = drizzle(sqlite, { schema });

  return {
    db,
    close: () => {
      sqlite.close();
    },
  };
}
