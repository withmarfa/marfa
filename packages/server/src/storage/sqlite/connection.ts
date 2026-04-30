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
  extra,
  tokenize='porter unicode61'
);
`;

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
export type RawDb = InstanceType<typeof Database>;

/**
 * Opens a SQLite connection, enables WAL mode, creates all tables
 * (idempotent), and returns both the Drizzle db and raw better-sqlite3 instances.
 */
export function createConnection(sqlitePath: string): {
  db: DrizzleDb;
  raw: RawDb;
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
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT,
      config TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      avatar_url TEXT,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      handle TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      tier TEXT NOT NULL DEFAULT 'library',
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
      capture_latitude REAL,
      capture_longitude REAL
    );

    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_state ON items(state);
    CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at);
    CREATE INDEX IF NOT EXISTS idx_items_timestamp ON items(timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_dedup
      ON items(source, source_id) WHERE source IS NOT NULL;

    CREATE TABLE IF NOT EXISTS metadata (
      item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(tenant_id, source_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(tenant_id, target_id, edge_type);

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      properties TEXT NOT NULL,
      created_at TEXT NOT NULL,
      device TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_versions_item_id ON versions(item_id);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      source TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      default_origin TEXT NOT NULL DEFAULT 'user',
      default_tier TEXT NOT NULL DEFAULT 'library',
      is_platform INTEGER NOT NULL DEFAULT 0,
      type_permissions TEXT NOT NULL DEFAULT '{"*":"write"}',
      extension_permissions TEXT NOT NULL DEFAULT '{}',
      edge_permissions TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_source_per_tenant
      ON api_keys(tenant_id, source) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_types (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      schema TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_edge_types (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      schema TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    -- PR 4 of workstream 1: oauth_grants dropped. Grants now live as
    -- system.connection items (kind: user-app-grant) referenced via
    -- connection_item_id (FK to items.id).
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id TEXT PRIMARY KEY,
      connection_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_type TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_connection_item_id ON oauth_tokens(connection_item_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_token_hash ON oauth_tokens(token_hash);

    CREATE TABLE IF NOT EXISTS oauth_codes (
      id TEXT PRIMARY KEY,
      connection_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      type_filter TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event TEXT NOT NULL,
      status_code INTEGER,
      attempt INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      next_attempt_at TEXT,
      payload TEXT,
      webhook_url TEXT,
      webhook_secret TEXT,
      max_attempts INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
      ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      key_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_resource_type ON audit_log(resource_type);

    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      item_id TEXT,
      edge_id TEXT,
      tenant_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_event_log_edge_id ON event_log(edge_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Better Auth tables (auth_* prefix, isolated from myme's own users table).
    -- Timestamps stored as INTEGER (Unix seconds) to match Drizzle
    -- integer(mode:timestamp) Date round-trip; the better-auth adapter
    -- forwards JS Date objects directly.
    CREATE TABLE IF NOT EXISTS auth_user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_user_email ON auth_user(email);

    CREATE TABLE IF NOT EXISTS auth_session (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_auth_session_user_id ON auth_session(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_session_token ON auth_session(token);

    CREATE TABLE IF NOT EXISTS auth_account (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at INTEGER,
      refresh_token_expires_at INTEGER,
      scope TEXT,
      password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_account_user_id ON auth_account(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_account_provider ON auth_account(provider_id, account_id);

    CREATE TABLE IF NOT EXISTS auth_verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_verification_identifier ON auth_verification(identifier);

    CREATE TABLE IF NOT EXISTS auth_passkey (
      id TEXT PRIMARY KEY,
      name TEXT,
      public_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL,
      counter INTEGER NOT NULL,
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL,
      transports TEXT,
      created_at INTEGER,
      aaguid TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_passkey_user_id ON auth_passkey(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_passkey_credential_id ON auth_passkey(credential_id);
  `);

  // Schema source of truth is the Drizzle migrations under drizzle/sqlite/.
  // The CREATE TABLE block above is the fresh-database bootstrap path
  // (notably tests via :memory:); it mirrors what running `pnpm migrate`
  // from 0000 would produce. Schema changes go in a Drizzle migration; do
  // NOT add new inline DDL here.
  //
  // One documented exception remains inline: the FTS5 virtual table below.
  // Drizzle Kit cannot express FTS5; the table is owned by sqlite-only.

  // Create FTS5 virtual table
  sqlite.exec(CREATE_FTS);

  // Migration: add 'extra' column to FTS5 table for custom type property search.
  // FTS5 does not support ALTER TABLE, so we detect the old schema and rebuild.
  try {
    sqlite.prepare("SELECT extra FROM items_fts LIMIT 0").run();
  } catch {
    // 'extra' column doesn't exist — rebuild the FTS5 table
    sqlite.exec("DROP TABLE IF EXISTS items_fts");
    sqlite.exec(CREATE_FTS);
    // Re-index all items (extra defaults to empty since we don't have type context here)
    const allItems = sqlite
      .prepare("SELECT id, properties FROM items WHERE state != 'trashed'")
      .all() as { id: string; properties: string }[];
    const insertStmt = sqlite.prepare(
      `INSERT INTO items_fts(item_id, title, body, description, name, extra)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of allItems) {
      try {
        const props = JSON.parse(row.properties) as Record<string, unknown>;
        const title = typeof props.title === "string" ? props.title : "";
        const body = typeof props.body === "string" ? props.body : "";
        const desc =
          typeof props.description === "string" ? props.description : "";
        const name = typeof props.name === "string" ? props.name : "";
        insertStmt.run(row.id, title, body, desc, name, "");
      } catch {
        // skip rows with unparseable properties
      }
    }
  }

  const db = drizzle(sqlite, { schema });

  return {
    db,
    raw: sqlite,
    close: () => {
      sqlite.close();
    },
  };
}
