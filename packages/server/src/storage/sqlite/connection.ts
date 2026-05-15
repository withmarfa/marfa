import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";
import { stampSqliteDrizzleMigrations } from "../bootstrap-stamp.js";

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
export type RawDb = Client;

/**
 * Translate a filesystem path or `:memory:` into the URL shape libsql expects.
 *
 * - `":memory:"` becomes `"file::memory:?cache=shared"` so multiple logical
 *   connections (e.g. the writer connection an interactive transaction holds)
 *   share one in-memory database. Plain `:memory:` gives each libsql logical
 *   connection its own isolated DB, which breaks the moment a transaction
 *   opens — the tx connection sees a different empty database.
 * - File paths become `file:<path>`.
 * - Already-formed URLs (`file:`, `http://`, `https://`, `libsql://`) pass
 *   through unchanged so callers can pin to remote replicas if needed.
 */
function toLibsqlUrl(pathOrUrl: string): string {
  if (pathOrUrl === ":memory:") return "file::memory:?cache=shared";
  if (
    pathOrUrl.startsWith("file:") ||
    pathOrUrl.startsWith("http://") ||
    pathOrUrl.startsWith("https://") ||
    pathOrUrl.startsWith("libsql://")
  ) {
    return pathOrUrl;
  }
  return `file:${pathOrUrl}`;
}

/**
 * Opens a libsql connection, enables WAL mode, creates all tables
 * (idempotent), and returns both the Drizzle db and the raw libsql client.
 */
export async function createConnection(sqlitePath: string): Promise<{
  db: DrizzleDb;
  raw: RawDb;
  close: () => Promise<void>;
}> {
  // Ensure the directory exists for filesystem paths (skip for in-memory and
  // already-formed URLs).
  if (
    sqlitePath !== ":memory:" &&
    !sqlitePath.startsWith("file:") &&
    !sqlitePath.startsWith("http") &&
    !sqlitePath.startsWith("libsql:")
  ) {
    const dir = dirname(sqlitePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const client = createClient({ url: toLibsqlUrl(sqlitePath) });

  // Enable WAL for better concurrent read/write performance. PRAGMA is a
  // no-op on libsql remote URLs but harmless.
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");

  // Create tables via raw SQL (idempotent — CREATE TABLE IF NOT EXISTS)
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT,
      config TEXT,
      created_at TEXT NOT NULL,
      -- T-117: operator-controlled status. 'active' (default) allows writes;
      -- 'suspended' blocks them at the auth middleware. Reads pass through.
      status TEXT NOT NULL DEFAULT 'active'
    );

    -- T-074: profile columns + auth_user_id FK; email + avatar_url dropped.
    -- Single source of truth for email lives on auth_user; the profile API
    -- joins through auth_user_id. Avatar is content-addressed via blob hash.
    -- Note: auth_user is created later in this script; the FK is captured
    -- in Drizzle's schema (so migrations emit it) but kept off the bootstrap
    -- DDL since SQLite doesn't enforce FKs by default.
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      first_name TEXT,
      last_name TEXT,
      bio TEXT,
      avatar_blob_hash TEXT,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      handle TEXT,
      auth_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_user_id ON users(auth_user_id);

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
      default_tier TEXT NOT NULL DEFAULT 'library',
      is_platform INTEGER NOT NULL DEFAULT 0,
      is_runtime_credential INTEGER NOT NULL DEFAULT 0,
      connection_id TEXT,
      type_permissions TEXT NOT NULL DEFAULT '{"*":"write"}',
      extension_permissions TEXT NOT NULL DEFAULT '{}',
      edge_permissions TEXT NOT NULL DEFAULT '{}',
      metadata_permissions TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_source_per_tenant
      ON api_keys(tenant_id, source) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_api_keys_connection_id
      ON api_keys(connection_id) WHERE connection_id IS NOT NULL;

    -- T-052: per-tenant resource quotas (Wave B PR4). NULL columns fall
    -- back to env defaults; missing rows mean "use defaults across the
    -- board" (the common case for newly-created tenants).
    CREATE TABLE IF NOT EXISTS tenant_quotas (
      tenant_id TEXT PRIMARY KEY,
      items_limit INTEGER,
      webhooks_limit INTEGER,
      blobs_limit INTEGER,
      storage_bytes_limit INTEGER,
      rate_per_minute_limit INTEGER,
      updated_at TEXT NOT NULL
    );

    -- T-049: composite PK on (tenant_id, hash). Empty-string sentinel for
    -- instance-wide / single-tenant / platform-admin rows. Different tenants
    -- uploading the same hash bytes get separate rows; storage backend dedupes
    -- the physical file by hash.
    CREATE TABLE IF NOT EXISTS blobs (
      tenant_id TEXT NOT NULL DEFAULT '',
      hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      PRIMARY KEY (tenant_id, hash)
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
    -- system.connection items (kind: app) referenced via
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

    CREATE TABLE IF NOT EXISTS oauth_device_codes (
      id TEXT PRIMARY KEY,
      device_code_hash TEXT NOT NULL UNIQUE,
      user_code TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      connection_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
      expires_at TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL DEFAULT 5,
      last_polled_at TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_user_code ON oauth_device_codes(user_code);
    CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_status ON oauth_device_codes(status);

    CREATE TABLE IF NOT EXISTS outbound_webhooks (
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

    CREATE TABLE IF NOT EXISTS inbound_webhooks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      connection_id TEXT NOT NULL,
      external_service_id TEXT,
      secret_encrypted TEXT NOT NULL,
      verification_method TEXT NOT NULL,
      verification_adapter_id TEXT,
      events TEXT NOT NULL DEFAULT '[]',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_webhooks_connection_id ON inbound_webhooks(connection_id);

    CREATE TABLE IF NOT EXISTS inbound_webhook_events (
      id TEXT PRIMARY KEY,
      inbound_webhook_id TEXT NOT NULL,
      external_delivery_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      verified INTEGER NOT NULL,
      processed_at TEXT,
      processing_error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_webhook_events_dedup
      ON inbound_webhook_events(inbound_webhook_id, external_delivery_id);
    CREATE INDEX IF NOT EXISTS idx_inbound_webhook_events_pending
      ON inbound_webhook_events(next_attempt_at)
      WHERE processed_at IS NULL AND processing_error IS NULL;

    CREATE TABLE IF NOT EXISTS connection_oauth_tokens (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      tenant_id TEXT,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      expires_at TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      previous_refresh_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_oauth_tokens_connection_id
      ON connection_oauth_tokens(connection_id);

    CREATE TABLE IF NOT EXISTS connection_leased_tokens (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      tenant_id TEXT,
      capability_id TEXT NOT NULL,
      lease_token_hash TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      issued_by_key_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_leased_tokens_hash
      ON connection_leased_tokens(lease_token_hash);
    CREATE INDEX IF NOT EXISTS idx_connection_leased_tokens_connection_id
      ON connection_leased_tokens(connection_id, expires_at);

    CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
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
    CREATE INDEX IF NOT EXISTS idx_outbound_webhook_deliveries_webhook_id ON outbound_webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_webhook_deliveries_pending
      ON outbound_webhook_deliveries(next_attempt_at) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      key_id TEXT,
      tenant_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_resource_type ON audit_log(resource_type);
    CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id ON audit_log(tenant_id);

    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      item_id TEXT,
      edge_id TEXT,
      tenant_id TEXT,
      payload TEXT NOT NULL,
      originating_connection_id TEXT,
      hop_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_event_log_edge_id ON event_log(edge_id);
    CREATE INDEX IF NOT EXISTS idx_event_log_originating_connection_id
      ON event_log(originating_connection_id, id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- T-026: cluster-shared rate-limit + per-email throttle counters.
    -- One physical table; family discriminates the two consumer surfaces.
    -- See pg/schema.ts for the full design note.
    CREATE TABLE IF NOT EXISTS rate_limit_windows (
      family TEXT NOT NULL,
      window_key TEXT NOT NULL,
      count INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (family, window_key)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_expires_at
      ON rate_limit_windows(expires_at);

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
      updated_at INTEGER NOT NULL,
      -- T-116: account-lifecycle state. See sqlite/schema.ts for the design note.
      deletion_state TEXT NOT NULL DEFAULT 'active',
      pending_deletion_at TEXT
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
  await client.executeMultiple(CREATE_FTS);

  // Migration: add 'extra' column to FTS5 table for custom type property search.
  // FTS5 does not support ALTER TABLE, so we detect the old schema and rebuild.
  let needsFtsRebuild = false;
  try {
    await client.execute("SELECT extra FROM items_fts LIMIT 0");
  } catch {
    needsFtsRebuild = true;
  }
  if (needsFtsRebuild) {
    // 'extra' column doesn't exist — rebuild the FTS5 table
    await client.executeMultiple("DROP TABLE IF EXISTS items_fts");
    await client.executeMultiple(CREATE_FTS);
    // Re-index all items (extra defaults to empty since we don't have type context here)
    const allItems = await client.execute(
      "SELECT id, properties FROM items WHERE state != 'trashed'",
    );
    for (const row of allItems.rows) {
      try {
        const id = row.id as string;
        const propertiesText = row.properties as string;
        const props = JSON.parse(propertiesText) as Record<string, unknown>;
        const title = typeof props.title === "string" ? props.title : "";
        const body = typeof props.body === "string" ? props.body : "";
        const desc =
          typeof props.description === "string" ? props.description : "";
        const name = typeof props.name === "string" ? props.name : "";
        await client.execute({
          sql: `INSERT INTO items_fts(item_id, title, body, description, name, extra)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [id, title, body, desc, name, ""],
        });
      } catch {
        // skip rows with unparseable properties
      }
    }
  }

  // Stamp Drizzle's `__drizzle_migrations` table so a follow-up
  // `pnpm migrate` against this bootstrapped DB short-circuits as a no-op
  // (T-014). Without this, migrate replays from 0000 and several DROP /
  // ALTER migrations error against tables / objects the bootstrap shape
  // never had. Idempotent — only stamps when the table is empty.
  await stampSqliteDrizzleMigrations(client);

  const db = drizzle(client, { schema });

  return {
    db,
    raw: client,
    close: async () => {
      client.close();
    },
  };
}

// Re-export sql for sites that build raw SQL through drizzle's tag.
export { sql };
