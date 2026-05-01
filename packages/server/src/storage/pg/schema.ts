import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// tenants + users (hosted mode)
// ---------------------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name"),
  config: jsonb("config"),
  created_at: text("created_at").notNull(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name"),
    avatar_url: text("avatar_url"),
    provider: text("provider").notNull(),
    provider_id: text("provider_id").notNull(),
    tenant_id: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    handle: text("handle"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_users_provider").on(table.provider, table.provider_id),
    uniqueIndex("idx_users_handle").on(table.handle),
  ],
);

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id"),
    type: text("type").notNull(),
    state: text("state").notNull().default("active"),
    tier: text("tier").notNull().default("library"),
    properties: text("properties").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    timestamp: text("timestamp").notNull(),
    source: text("source"),
    source_id: text("source_id"),
    origin: text("origin"),
    version: integer("version").notNull().default(1),
    schema_version: integer("schema_version"),
    device: text("device"),
    capture_latitude: doublePrecision("capture_latitude"),
    capture_longitude: doublePrecision("capture_longitude"),
  },
  (table) => [
    index("idx_items_type").on(table.type),
    index("idx_items_state").on(table.state),
    index("idx_items_created_at").on(table.created_at),
    index("idx_items_timestamp").on(table.timestamp),
    uniqueIndex("idx_items_source_dedup")
      .on(table.source, table.source_id)
      .where(sql`source IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// metadata (1:1 sidecar for items)
// ---------------------------------------------------------------------------

export const metadata = pgTable("metadata", {
  item_id: text("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  tags: text("tags").notNull().default("[]"),
  extensions: text("extensions").notNull().default("{}"),
});

// ---------------------------------------------------------------------------
// edges (first-class typed relationships between items)
// ---------------------------------------------------------------------------

export const edges = pgTable(
  "edges",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id"),
    // source_id and target_id are NOT foreign keys to items(id). App-level
    // existence checks run in assertEdgeCanBeCreated; orphan-edge cleanup on
    // item delete is handled by planCascadeDelete + explicit
    // edgeStore.deleteBySource / deleteByTarget calls.
    source_id: text("source_id").notNull(),
    target_id: text("target_id").notNull(),
    edge_type: text("edge_type").notNull(),
    properties: text("properties").notNull().default("{}"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_edges_source").on(
      table.tenant_id,
      table.source_id,
      table.edge_type,
    ),
    index("idx_edges_target").on(
      table.tenant_id,
      table.target_id,
      table.edge_type,
    ),
  ],
);

// ---------------------------------------------------------------------------
// versions (item property snapshots)
// ---------------------------------------------------------------------------

export const versions = pgTable(
  "versions",
  {
    id: text("id").primaryKey(),
    item_id: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    properties: text("properties").notNull(),
    created_at: text("created_at").notNull(),
    device: text("device"),
  },
  (table) => [index("idx_versions_item_id").on(table.item_id)],
);

// ---------------------------------------------------------------------------
// api_keys
// ---------------------------------------------------------------------------

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id"),
    key_hash: text("key_hash").notNull().unique(),
    label: text("label").notNull(),
    source: text("source").notNull(),
    role: text("role").notNull().default("member"),
    default_origin: text("default_origin").notNull().default("user"),
    default_tier: text("default_tier").notNull().default("library"),
    is_platform: boolean("is_platform").notNull().default(false),
    is_runtime_credential: boolean("is_runtime_credential")
      .notNull()
      .default(false),
    connection_id: text("connection_id"),
    type_permissions: text("type_permissions")
      .notNull()
      .default('{"*":"write"}'),
    extension_permissions: text("extension_permissions")
      .notNull()
      .default("{}"),
    edge_permissions: text("edge_permissions").notNull().default("{}"),
    metadata_permissions: text("metadata_permissions").notNull().default("{}"),
    created_at: text("created_at").notNull(),
    revoked_at: text("revoked_at"),
    last_used_at: text("last_used_at"),
  },
  (table) => [
    uniqueIndex("idx_api_keys_source_per_tenant")
      .on(table.tenant_id, table.source)
      .where(sql`revoked_at IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// blobs (metadata only — actual files on filesystem)
// ---------------------------------------------------------------------------

export const blobs = pgTable("blobs", {
  hash: text("hash").primaryKey(),
  mime_type: text("mime_type").notNull(),
  size: integer("size").notNull(),
  storage_path: text("storage_path").notNull(),
});

// ---------------------------------------------------------------------------
// OAuth tables
// ---------------------------------------------------------------------------

export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirect_uris: text("redirect_uris").notNull().default("[]"),
  created_at: text("created_at").notNull(),
});

// PR 4 of workstream 1: oauth_grants table dropped. The user-facing
// concept "user X approved client Y with scopes Z" now lives as a
// `system.connection` item with `kind: user-app-grant`. The token
// tables FK directly to items.id via connection_item_id.

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    connection_item_id: text("connection_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull().unique(),
    token_type: text("token_type").notNull(),
    expires_at: text("expires_at").notNull(),
    revoked_at: text("revoked_at"),
    used_at: text("used_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_oauth_tokens_connection_item_id").on(table.connection_item_id),
    index("idx_oauth_tokens_token_hash").on(table.token_hash),
  ],
);

// ---------------------------------------------------------------------------
// oauth_device_codes — Device Authorization Grant (RFC 8628)
// ---------------------------------------------------------------------------

export const oauthDeviceCodes = pgTable(
  "oauth_device_codes",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the raw device_code returned to the polling client. */
    device_code_hash: text("device_code_hash").notNull().unique(),
    /** Short, low-entropy code displayed to the human (XXXX-XXXX shape). */
    user_code: text("user_code").notNull().unique(),
    client_id: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    status: text("status").notNull().default("pending"),
    connection_item_id: text("connection_item_id").references(() => items.id, {
      onDelete: "set null",
    }),
    expires_at: text("expires_at").notNull(),
    interval_seconds: integer("interval_seconds").notNull().default(5),
    last_polled_at: text("last_polled_at"),
    approved_at: text("approved_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_oauth_device_codes_user_code").on(table.user_code),
    index("idx_oauth_device_codes_status").on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// custom_types (runtime type registration)
// ---------------------------------------------------------------------------

export const customTypes = pgTable("custom_types", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id"),
  schema: text("schema").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const customEdgeTypes = pgTable("custom_edge_types", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id"),
  schema: text("schema").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// outbound_webhooks
// ---------------------------------------------------------------------------

export const outboundWebhooks = pgTable("outbound_webhooks", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id"),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: text("events").notNull().default("[]"),
  type_filter: text("type_filter"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// outbound_webhook_deliveries
// ---------------------------------------------------------------------------

export const outboundWebhookDeliveries = pgTable(
  "outbound_webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhook_id: text("webhook_id").notNull(),
    event: text("event").notNull(),
    status_code: integer("status_code"),
    attempt: integer("attempt").notNull(),
    success: integer("success").notNull().default(0),
    error: text("error"),
    created_at: text("created_at").notNull(),
    next_attempt_at: text("next_attempt_at"),
    payload: text("payload"),
    webhook_url: text("webhook_url"),
    webhook_secret: text("webhook_secret"),
    max_attempts: integer("max_attempts").notNull().default(4),
    status: text("status").notNull().default("pending"),
  },
  (table) => [
    index("idx_outbound_webhook_deliveries_webhook_id").on(table.webhook_id),
  ],
);

// ---------------------------------------------------------------------------
// inbound_webhooks (workstream 2 PR 5)
// ---------------------------------------------------------------------------

export const inboundWebhooks = pgTable(
  "inbound_webhooks",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id"),
    // App-level reference to a system.connection item (kind:
    // external-service-connector). Not a DB-level FK — matches the
    // existing pattern for other connection-referencing tables.
    connection_id: text("connection_id").notNull(),
    // The external service's id for this subscription. Retained for
    // operator correlation; not unique.
    external_service_id: text("external_service_id"),
    // AES-256-GCM(secret) under HKDF(MYME_AUTH_SECRET,
    // "inbound-webhook-secrets"). Per-row IV is stored in the first 12
    // bytes of the ciphertext — see crypto/secret-encryption.ts.
    secret_encrypted: text("secret_encrypted").notNull(),
    // Verification method stamped at subscription time from the
    // submitted manifest's webhook_verification.method.
    verification_method: text("verification_method").notNull(),
    // Non-null when verification_method === 'custom'.
    verification_adapter_id: text("verification_adapter_id"),
    events: text("events").notNull().default("[]"),
    // Use integer for cross-dialect parity with sqlite — both stores
    // marshal `disabled === 1` to `boolean` at the row-mapping layer.
    disabled: integer("disabled").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_inbound_webhooks_connection_id").on(table.connection_id),
  ],
);

// ---------------------------------------------------------------------------
// inbound_webhook_events (workstream 2 PR 5)
// ---------------------------------------------------------------------------

export const inboundWebhookEvents = pgTable(
  "inbound_webhook_events",
  {
    id: text("id").primaryKey(),
    inbound_webhook_id: text("inbound_webhook_id").notNull(),
    // Sender's idempotency identifier. Combined with inbound_webhook_id
    // via the unique index below to enforce at-most-once processing.
    external_delivery_id: text("external_delivery_id").notNull(),
    received_at: text("received_at").notNull(),
    payload: text("payload").notNull(),
    verified: integer("verified").notNull(),
    // NULL = not yet processed. WS3's reactive runner stamps this when
    // it finishes work; verified-but-not-processed rows are the queue.
    processed_at: text("processed_at"),
    // NULL = no error yet. Populated when retries are exhausted (DLQ).
    processing_error: text("processing_error"),
    retry_count: integer("retry_count").notNull().default(0),
    next_attempt_at: text("next_attempt_at"),
  },
  (table) => [
    uniqueIndex("idx_inbound_webhook_events_dedup").on(
      table.inbound_webhook_id,
      table.external_delivery_id,
    ),
    index("idx_inbound_webhook_events_pending")
      .on(table.next_attempt_at)
      .where(sql`processed_at IS NULL AND processing_error IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// connection_oauth_tokens (workstream 2 PR 6)
//
// Mirror of the SQLite table; see sqlite/schema.ts for the design notes.
// ---------------------------------------------------------------------------

export const connectionOauthTokens = pgTable(
  "connection_oauth_tokens",
  {
    id: text("id").primaryKey(),
    connection_id: text("connection_id").notNull(),
    tenant_id: text("tenant_id"),
    access_token_encrypted: text("access_token_encrypted").notNull(),
    refresh_token_encrypted: text("refresh_token_encrypted"),
    expires_at: text("expires_at").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    previous_refresh_hash: text("previous_refresh_hash"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_connection_oauth_tokens_connection_id").on(
      table.connection_id,
    ),
  ],
);

// ---------------------------------------------------------------------------
// connection_leased_tokens (workstream 2 PR 7)
//
// Mirror of the SQLite table; see sqlite/schema.ts for the design notes.
// ---------------------------------------------------------------------------

export const connectionLeasedTokens = pgTable(
  "connection_leased_tokens",
  {
    id: text("id").primaryKey(),
    connection_id: text("connection_id").notNull(),
    tenant_id: text("tenant_id"),
    capability_id: text("capability_id").notNull(),
    lease_token_hash: text("lease_token_hash").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    expires_at: text("expires_at").notNull(),
    revoked_at: text("revoked_at"),
    issued_by_key_id: text("issued_by_key_id"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_connection_leased_tokens_hash").on(table.lease_token_hash),
    index("idx_connection_leased_tokens_connection_id").on(
      table.connection_id,
      table.expires_at,
    ),
  ],
);

export const oauthCodes = pgTable("oauth_codes", {
  id: text("id").primaryKey(),
  connection_item_id: text("connection_item_id")
    .notNull()
    .references(() => items.id, { onDelete: "cascade" }),
  code_hash: text("code_hash").notNull().unique(),
  code_challenge: text("code_challenge").notNull(),
  code_challenge_method: text("code_challenge_method").notNull(),
  redirect_uri: text("redirect_uri").notNull(),
  expires_at: text("expires_at").notNull(),
  used_at: text("used_at"),
  created_at: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// audit_log (append-only audit trail)
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    timestamp: text("timestamp").notNull(),
    key_id: text("key_id"),
    action: text("action").notNull(),
    resource_type: text("resource_type").notNull(),
    resource_id: text("resource_id"),
    details: text("details").notNull().default("{}"),
  },
  (table) => [
    index("idx_audit_log_timestamp").on(table.timestamp),
    index("idx_audit_log_action").on(table.action),
    index("idx_audit_log_resource_type").on(table.resource_type),
  ],
);

// ---------------------------------------------------------------------------
// settings (generic single-row-per-key KV for workspace-wide flags)
// ---------------------------------------------------------------------------

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ---------------------------------------------------------------------------
// event_log (SSE event persistence for replay)
// ---------------------------------------------------------------------------

export const eventLog = pgTable(
  "event_log",
  {
    // BIGINT, not INT4: event_log is append-only and INT4 (~2.1B) is a
    // foreseeable wrap. `mode: "number"` keeps the JS runtime type a
    // number (safe to 2^53), matching consumer expectations in
    // event-log-store.ts and routes/events.ts (Last-Event-ID parseInt).
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    event_type: text("event_type").notNull(),
    // Nullable: item events set item_id and leave edge_id null; edge
    // events set edge_id and leave item_id null. Relaxed from NOT NULL
    // in migration 0014.
    item_id: text("item_id"),
    edge_id: text("edge_id"),
    tenant_id: text("tenant_id"),
    payload: text("payload").notNull(),
    // Cycle-detection metadata (workstream 2 PR 8); see sqlite/schema.ts
    // for design notes.
    originating_connection_id: text("originating_connection_id"),
    hop_count: integer("hop_count").notNull().default(0),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_event_log_created_at").on(table.created_at),
    index("idx_event_log_edge_id").on(table.edge_id),
    index("idx_event_log_originating_connection_id").on(
      table.originating_connection_id,
      table.id,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Better Auth tables (auth_* prefix, isolated from myme's own users table)
//
// These are owned and managed by the better-auth library; the schema mirrors
// what `npx @better-auth/cli generate` produces, hand-translated to Drizzle
// for both dialects. Column names use the camelCase keys better-auth expects.
// ---------------------------------------------------------------------------

// Timestamp columns use `timestamp({ mode: "date" })` so the better-auth
// Drizzle adapter — which forwards JS Date objects — can round-trip.
// This deviates from myme's TEXT-ISO convention but stays localised
// to the auth_* island.
export const auth_user = pgTable(
  "auth_user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  },
  (table) => [uniqueIndex("idx_auth_user_email").on(table.email)],
);

export const auth_session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("idx_auth_session_user_id").on(table.userId),
    uniqueIndex("idx_auth_session_token").on(table.token),
  ],
);

export const auth_account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  },
  (table) => [
    index("idx_auth_account_user_id").on(table.userId),
    uniqueIndex("idx_auth_account_provider").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const auth_verification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  },
  (table) => [index("idx_auth_verification_identifier").on(table.identifier)],
);

// Passkey credentials (one per registered authenticator).
export const auth_passkey = pgTable(
  "auth_passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at", { mode: "date" }),
    aaguid: text("aaguid"),
  },
  (table) => [
    index("idx_auth_passkey_user_id").on(table.userId),
    index("idx_auth_passkey_credential_id").on(table.credentialID),
  ],
);
