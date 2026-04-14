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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  parent_id TEXT,
  thread_id TEXT REFERENCES threads(id),
  capture_latitude DOUBLE PRECISION,
  capture_longitude DOUBLE PRECISION
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
  default_library BOOLEAN NOT NULL DEFAULT false,
  type_permissions TEXT NOT NULL DEFAULT '{"*":"write"}',
  extension_permissions TEXT NOT NULL DEFAULT '{}',
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

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_client_id ON oauth_grants(client_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant_id ON oauth_tokens(grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_token_hash ON oauth_tokens(token_hash);

CREATE TABLE IF NOT EXISTS oauth_codes (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);

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
  item_id TEXT NOT NULL,
  tenant_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log(created_at);
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
  // Two documented exceptions remain inline because Drizzle Kit cannot
  // express them: the FTS5 virtual table in sqlite/connection.ts, and the
  // RLS policies below (Postgres-only).
  await client.unsafe(`SELECT pg_advisory_lock(42)`);
  try {
    await client.unsafe(SCHEMA_SQL);

    // Row Level Security — defense-in-depth for multi-tenant isolation.
    //
    // STATUS: dormant. The connection user is the table owner and bypasses
    // RLS by default; the policies below have no runtime effect today. They
    // are kept inline (Drizzle Kit cannot express RLS) so production hosted
    // deployments that run as a non-owner role (e.g. `myme_app` granted
    // SELECT/INSERT/UPDATE/DELETE on the relevant tables) inherit isolation
    // automatically. The server is expected to set the per-request scope
    // via `SET LOCAL myme.tenant_id = ...`. Activation is a deployment-side
    // change (role swap), not a code change.
    await client.unsafe(`
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
      ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
      ALTER TABLE metadata ENABLE ROW LEVEL SECURITY;
      ALTER TABLE versions ENABLE ROW LEVEL SECURITY;

      DO $$ BEGIN
        CREATE POLICY tenant_isolation_items ON items
          USING (tenant_id = current_setting('myme.tenant_id', true));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY tenant_isolation_api_keys ON api_keys
          USING (tenant_id = current_setting('myme.tenant_id', true));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY tenant_isolation_threads ON threads
          USING (tenant_id = current_setting('myme.tenant_id', true));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY tenant_isolation_metadata ON metadata
          USING (EXISTS (
            SELECT 1 FROM items WHERE items.id = metadata.item_id
            AND items.tenant_id = current_setting('myme.tenant_id', true)
          ));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY tenant_isolation_versions ON versions
          USING (EXISTS (
            SELECT 1 FROM items WHERE items.id = versions.item_id
            AND items.tenant_id = current_setting('myme.tenant_id', true)
          ));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
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
