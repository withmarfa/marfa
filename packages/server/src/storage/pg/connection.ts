import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type PgDb = ReturnType<typeof drizzle<typeof schema>>;
export type PgClient = ReturnType<typeof postgres>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT,
  config JSONB,
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
  capture_latitude DOUBLE PRECISION,
  capture_longitude DOUBLE PRECISION
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
  is_platform BOOLEAN NOT NULL DEFAULT false,
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
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
-- Timestamps stored as TIMESTAMP to match Drizzle timestamp(mode:date)
-- Date round-trip; the better-auth adapter forwards JS Date objects directly.
CREATE TABLE IF NOT EXISTS auth_user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_user_email ON auth_user(email);

CREATE TABLE IF NOT EXISTS auth_session (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMP NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
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
  access_token_expires_at TIMESTAMP,
  refresh_token_expires_at TIMESTAMP,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_account_user_id ON auth_account(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_account_provider ON auth_account(provider_id, account_id);

CREATE TABLE IF NOT EXISTS auth_verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
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
  backed_up BOOLEAN NOT NULL,
  transports TEXT,
  created_at TIMESTAMP,
  aaguid TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_passkey_user_id ON auth_passkey(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_passkey_credential_id ON auth_passkey(credential_id);
`;

export async function createConnection(connectionString: string): Promise<{
  db: PgDb;
  client: PgClient;
  close: () => Promise<void>;
}> {
  const client = postgres(connectionString, {
    max: 10,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });

  // Apply schema — use advisory lock to prevent concurrent DDL race conditions.
  //
  // Schema source of truth is the Drizzle migrations under drizzle/pg/. The
  // SCHEMA_SQL block above is the fresh-database bootstrap path used when the
  // server starts against an empty database (notably tests via :memory:); it
  // mirrors what running `pnpm migrate` from 0000 would produce. Schema
  // changes go in a Drizzle migration; do NOT add new inline DDL here.
  //
  // The FTS5 virtual table in sqlite/connection.ts remains inline because
  // Drizzle Kit cannot express it.
  //
  // ─── Postgres Row Level Security — intentionally NOT enabled ────────────
  //
  // A previous version of this file shipped dormant RLS policies on items,
  // api_keys, metadata, and versions. They had no runtime effect: the pool
  // user is the table owner and the table owner always bypasses RLS. To a
  // reader that's a credibility trap — security primitives that look like
  // they're guarding the data when they aren't.
  //
  // Real RLS would require three coordinated changes that we have not yet
  // made:
  //   1. A non-owner DB role (e.g. `myme_app`) granted CRUD on the tenant-
  //      scoped tables.
  //   2. `SET ROLE myme_app` on every connection check-out from the pool.
  //   3. Middleware that issues `SET LOCAL myme.tenant_id = $tenant` per
  //      request.
  //
  // Until those three land together, RLS provides nothing — so we don't
  // ship it. Tenant scoping today is enforced in application code: every
  // tenant-scoped query in item-store, search-store, key-store, and
  // event-log-store carries `tenant_id = ?`. The Backlog tracks the full
  // RLS plan for if/when hosted-multi-tenant becomes a concrete need.
  await client.unsafe(`SELECT pg_advisory_lock(42)`);
  try {
    await client.unsafe(SCHEMA_SQL);
  } finally {
    await client.unsafe(`SELECT pg_advisory_unlock(42)`);
  }

  return {
    db,
    client,
    close: async () => {
      await client.end();
    },
  };
}
