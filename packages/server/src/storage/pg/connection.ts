import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { stampPgDrizzleMigrations } from "../bootstrap-stamp.js";
import { wrapDbWithRequestContext } from "./request-context.js";

export type PgDb = ReturnType<typeof drizzle<typeof schema>>;
export type PgClient = ReturnType<typeof postgres>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT,
  config JSONB,
  created_at TEXT NOT NULL
);

-- T-074: profile columns + auth_user_id FK; email + avatar_url dropped.
-- Single source of truth for email lives on auth_user; the profile API
-- joins through auth_user_id. Avatar is content-addressed via blob hash.
-- Note: auth_user is created later in this script; the FK declaration
-- here is forward-referenced and resolved at table-creation time.
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
  capture_latitude DOUBLE PRECISION,
  capture_longitude DOUBLE PRECISION,
  -- T-015: materialised tsvector populated from properties at write
  -- time by the search store. NULL means not yet indexed (e.g. mid-
  -- backfill); the search query treats NULL the same as no rows. The
  -- index uses GIN; per-row size is dominated by the document
  -- dictionary so the column itself is small.
  search_vector TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_state ON items(state);
CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at);
CREATE INDEX IF NOT EXISTS idx_items_timestamp ON items(timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_dedup
  ON items(source, source_id) WHERE source IS NOT NULL;
-- T-015: GIN index on the materialised search_vector. Replaces the
-- per-request to_tsvector(...) sequential scan that the at-query-time
-- shape required.
CREATE INDEX IF NOT EXISTS idx_items_search_vector ON items USING GIN(search_vector);

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
  is_platform BOOLEAN NOT NULL DEFAULT false,
  is_runtime_credential BOOLEAN NOT NULL DEFAULT false,
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

-- T-052: per-tenant resource quotas. See sqlite/connection.ts for notes.
CREATE TABLE IF NOT EXISTS tenant_quotas (
  tenant_id TEXT PRIMARY KEY,
  items_limit INTEGER,
  webhooks_limit INTEGER,
  blobs_limit INTEGER,
  storage_bytes_limit BIGINT,
  rate_per_minute_limit INTEGER,
  updated_at TEXT NOT NULL
);

-- Wave C PR1: per-tenant email suppression list. Mirrored from Resend
-- webhooks; transport pre-send check consults this. Empty-string
-- tenant_id is the platform-level / pre-sign-in sentinel (mirrors
-- blob T-049 convention).
CREATE TABLE IF NOT EXISTS email_suppressions (
  tenant_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_email_id TEXT,
  PRIMARY KEY (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_email_suppressions_email
  ON email_suppressions (email);

-- T-049: composite PK on (tenant_id, hash). See sqlite/connection.ts for
-- design rationale. Empty-string sentinel for instance-wide rows.
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
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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

-- T-025 part 1: RLS scaffold. Mirrors migration 0035 so fresh-DB
-- bootstrap gets the role + policies. The connection-pool wiring
-- (transaction-per-request with SET LOCAL ROLE myme_app) lands as
-- T-025 part 2; until then policies have no effect because the
-- application connects as the table owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myme_app') THEN
    CREATE ROLE "myme_app";
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO "myme_app";
-- T-025 part 1 grants — RLS-policied tables + instance-wide reads.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "items", "edges", "versions", "metadata", "api_keys", "blobs",
  "custom_types", "custom_edge_types", "outbound_webhooks",
  "outbound_webhook_deliveries", "audit_log", "event_log",
  "tenants", "settings"
TO "myme_app";
-- T-025 part 2 grants — remaining tables myme_app needs to satisfy
-- request paths once role-switch-on-checkout activates. Policies on
-- inbound_webhooks, connection_oauth_tokens, and connection_leased_tokens
-- land in migration 0040 (Wave B Part 4 follow-on); the GRANTs alone
-- here let queries reach the rows, the policies below restrict them
-- per-tenant.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "inbound_webhooks", "inbound_webhook_events",
  "connection_oauth_tokens", "connection_leased_tokens",
  "oauth_clients", "oauth_codes", "oauth_tokens", "oauth_device_codes",
  "users", "tenant_quotas", "email_suppressions"
TO "myme_app";
-- Sequence usage so myme_app can insert into identity columns
-- (event_log.id BIGINT GENERATED ALWAYS AS IDENTITY).
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "myme_app";

ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "items_tenant_isolation" ON "items";
CREATE POLICY "items_tenant_isolation" ON "items"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

ALTER TABLE "edges" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "edges_tenant_isolation" ON "edges";
CREATE POLICY "edges_tenant_isolation" ON "edges"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

-- versions — keyed on item_id; policy joins via items.
ALTER TABLE "versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "versions_tenant_isolation" ON "versions";
CREATE POLICY "versions_tenant_isolation" ON "versions"
  FOR ALL TO "myme_app"
  USING (EXISTS (
    SELECT 1 FROM "items" WHERE "items".id = "versions".item_id
      AND ("items".tenant_id::text = current_setting('myme.tenant_id', true)
           OR "items".tenant_id IS NULL)
  ));

ALTER TABLE "metadata" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "metadata_tenant_isolation" ON "metadata";
CREATE POLICY "metadata_tenant_isolation" ON "metadata"
  FOR ALL TO "myme_app"
  USING (EXISTS (
    SELECT 1 FROM "items" WHERE "items".id = "metadata".item_id
      AND ("items".tenant_id::text = current_setting('myme.tenant_id', true)
           OR "items".tenant_id IS NULL)
  ));

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "api_keys_tenant_isolation" ON "api_keys";
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

ALTER TABLE "blobs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "blobs_tenant_isolation" ON "blobs";
CREATE POLICY "blobs_tenant_isolation" ON "blobs"
  FOR ALL TO "myme_app"
  USING (tenant_id = current_setting('myme.tenant_id', true)
         OR tenant_id = '');

ALTER TABLE "custom_types" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "custom_types_tenant_isolation" ON "custom_types";
CREATE POLICY "custom_types_tenant_isolation" ON "custom_types"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

ALTER TABLE "custom_edge_types" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "custom_edge_types_tenant_isolation" ON "custom_edge_types";
CREATE POLICY "custom_edge_types_tenant_isolation" ON "custom_edge_types"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

ALTER TABLE "outbound_webhooks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "outbound_webhooks_tenant_isolation" ON "outbound_webhooks";
CREATE POLICY "outbound_webhooks_tenant_isolation" ON "outbound_webhooks"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_log_tenant_isolation" ON "audit_log";
CREATE POLICY "audit_log_tenant_isolation" ON "audit_log"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

ALTER TABLE "event_log" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "event_log_tenant_isolation" ON "event_log";
CREATE POLICY "event_log_tenant_isolation" ON "event_log"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

-- Wave B Part 4 follow-on (migration 0040): RLS policies on the three
-- direct-tenant_id tables that received GRANTs in migration 0037 but
-- not yet policies. Same shape as the eleven tables above —
-- equality-on-current-setting plus NULL-allowance for single-tenant
-- self-host transparency.
ALTER TABLE "inbound_webhooks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inbound_webhooks_tenant_isolation" ON "inbound_webhooks";
CREATE POLICY "inbound_webhooks_tenant_isolation" ON "inbound_webhooks"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

ALTER TABLE "connection_oauth_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "connection_oauth_tokens_tenant_isolation" ON "connection_oauth_tokens";
CREATE POLICY "connection_oauth_tokens_tenant_isolation" ON "connection_oauth_tokens"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

ALTER TABLE "connection_leased_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "connection_leased_tokens_tenant_isolation" ON "connection_leased_tokens";
CREATE POLICY "connection_leased_tokens_tenant_isolation" ON "connection_leased_tokens"
  FOR ALL TO "myme_app"
  USING (tenant_id::text = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);

-- Wave C PR1 — email_suppressions tenant policy. tenant_id is TEXT
-- (no NULL — empty-string sentinel matches blob T-049 convention).
ALTER TABLE "email_suppressions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_suppressions_tenant_isolation" ON "email_suppressions";
CREATE POLICY "email_suppressions_tenant_isolation" ON "email_suppressions"
  FOR ALL TO "myme_app"
  USING (tenant_id = current_setting('myme.tenant_id', true)
         OR tenant_id = '');
`;

export async function createConnection(connectionString: string): Promise<{
  /**
   * Drizzle instance wrapped with the per-request context proxy
   * (T-025 part 2). Storage classes consume this so per-request
   * transactions (set up by the RLS middleware) transparently
   * substitute. Use for everything except Better Auth.
   */
  db: PgDb;
  /**
   * Unwrapped base Drizzle instance — bypasses the per-request
   * context. Reserved for Better Auth, which manages its own
   * connection / cookie context outside the data-plane request
   * middleware. Auth tables (`auth_*`) have no RLS policies and
   * always operate as the connection owner.
   */
  baseDb: PgDb;
  client: PgClient;
  close: () => Promise<void>;
}> {
  const client = postgres(connectionString, {
    max: 10,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  const baseDb = drizzle(client, { schema });
  const db = wrapDbWithRequestContext(baseDb);

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
  // ─── Postgres Row Level Security ─────────────────────────────────────────
  //
  // RLS lands in two coordinated parts:
  //
  // - T-025 part 1 (#161) — the schema scaffold: `myme_app` non-owner role,
  //   per-table CRUD grants, RLS-enabled tables, per-table policies keyed on
  //   `current_setting('myme.tenant_id', true)`. Mirrored from migration
  //   `0035_rls_application_role.sql` into the SCHEMA_SQL bootstrap above.
  //
  // - T-025 part 2 (#162-track) — the connection-pool wiring. The Drizzle
  //   `db` instance is wrapped in a per-request context proxy
  //   (`request-context.ts`). The RLS middleware (`rls-tenant-context.ts`)
  //   wraps each tenant-bounded request in a transaction with `SET LOCAL
  //   ROLE myme_app; SELECT set_config('myme.tenant_id', $1, true)` so
  //   every storage query in the request flows through the reserved
  //   connection. Activated via `MYME_RLS_ENFORCE=true`.
  //
  // With `MYME_RLS_ENFORCE=false` (the default) the proxy still exists but
  // the middleware never installs an ALS context, so all queries fall
  // through to the unwrapped base instance and run as the connection owner
  // (RLS bypassed by virtue of ownership). Single-tenant self-hosts are
  // unaffected.
  await client.unsafe(`SELECT pg_advisory_lock(42)`);
  try {
    await client.unsafe(SCHEMA_SQL);
    // Stamp Drizzle's `__drizzle_migrations` table so a follow-up
    // `pnpm migrate` against this bootstrapped DB short-circuits as a no-op
    // (T-014). Idempotent — only stamps when the table is empty.
    await stampPgDrizzleMigrations(client);
  } finally {
    await client.unsafe(`SELECT pg_advisory_unlock(42)`);
  }

  return {
    db,
    baseDb,
    client,
    close: async () => {
      await client.end();
    },
  };
}
