import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// tenants + users (hosted mode)
// ---------------------------------------------------------------------------

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name"),
  config: text("config"),
  created_at: text("created_at").notNull(),
});

export const users = sqliteTable(
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

export const items = sqliteTable(
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
    capture_latitude: real("capture_latitude"),
    capture_longitude: real("capture_longitude"),
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

export const metadata = sqliteTable("metadata", {
  item_id: text("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  tags: text("tags").notNull().default("[]"),
  extensions: text("extensions").notNull().default("{}"),
});

// ---------------------------------------------------------------------------
// edges (first-class typed relationships between items)
// ---------------------------------------------------------------------------

export const edges = sqliteTable(
  "edges",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id"),
    // No FKs on source_id / target_id — see pg/schema.ts note. App-level
    // checks run in assertEdgeCanBeCreated + planCascadeDelete.
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

export const versions = sqliteTable(
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

export const apiKeys = sqliteTable(
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
    is_platform: integer("is_platform", { mode: "boolean" })
      .notNull()
      .default(false),
    is_runtime_credential: integer("is_runtime_credential", { mode: "boolean" })
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

// T-049: blob rows are per-tenant. Same `hash` can appear under multiple
// tenant_ids; the file system / S3 backend dedupes physically (one file
// per hash), but the blobs table carries one row per (tenant_id, hash) so
// cross-tenant reads of `/blobs/:hash` resolve to the caller's row only —
// missing for a given tenant means 404.
//
// `tenant_id` is `NOT NULL DEFAULT ''` rather than nullable to keep the
// composite PK simple. Empty string `''` is the sentinel for
// "instance-wide / no tenant" — used by single-tenant self-hosts and by
// platform-admin uploads in hosted mode where the credential carries no
// tenant_id. The empty-string-as-sentinel asymmetry vs other tables (which
// use nullable `tenant_id`) is intentional: composite PKs with nullable
// columns behave inconsistently across SQLite and PG, and this table is
// the only place we need a composite primary identity.
export const blobs = sqliteTable(
  "blobs",
  {
    tenant_id: text("tenant_id").notNull().default(""),
    hash: text("hash").notNull(),
    mime_type: text("mime_type").notNull(),
    size: integer("size").notNull(),
    storage_path: text("storage_path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.hash] })],
);

// ---------------------------------------------------------------------------
// OAuth tables
// ---------------------------------------------------------------------------

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirect_uris: text("redirect_uris").notNull().default("[]"),
  created_at: text("created_at").notNull(),
});

// PR 4 of workstream 1: oauth_grants table dropped. The user-facing
// concept "user X approved client Y with scopes Z" now lives as a
// `system.connection` item with `kind: app`. The token
// tables FK directly to items.id via connection_item_id.

export const oauthTokens = sqliteTable(
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

export const oauthDeviceCodes = sqliteTable(
  "oauth_device_codes",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the raw device_code returned to the polling client.
     *  Uniqueness lets validateToken-style lookups stay constant-time. */
    device_code_hash: text("device_code_hash").notNull().unique(),
    /** Short, low-entropy code displayed to the human (XXXX-XXXX shape).
     *  Unique while the row is `pending`; once approved/denied/expired
     *  the row is preserved for audit but no new pending row may reuse
     *  the value (enforced by a unique index over the natural key). */
    user_code: text("user_code").notNull().unique(),
    client_id: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    /** Space-separated list of requested scopes. Stored verbatim;
     *  parsed via parseScope at consent / token time. */
    scope: text("scope").notNull(),
    /** Lifecycle: pending → approved | denied; expired by the cleanup
     *  job once `expires_at < now()`. */
    status: text("status").notNull().default("pending"),
    /** Set when status transitions to `approved`. References the
     *  system.connection (kind: app) created on approval. */
    connection_item_id: text("connection_item_id").references(() => items.id, {
      onDelete: "set null",
    }),
    expires_at: text("expires_at").notNull(),
    interval_seconds: integer("interval_seconds").notNull().default(5),
    /** Used by the polling endpoint to detect `slow_down` violations. */
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

export const customTypes = sqliteTable("custom_types", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id"),
  schema: text("schema").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const customEdgeTypes = sqliteTable("custom_edge_types", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id"),
  schema: text("schema").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// outbound_webhooks
// ---------------------------------------------------------------------------

export const outboundWebhooks = sqliteTable("outbound_webhooks", {
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

export const outboundWebhookDeliveries = sqliteTable(
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

export const inboundWebhooks = sqliteTable(
  "inbound_webhooks",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id"),
    // App-level reference to a system.connection item (kind:
    // integration). Not a DB-level FK — matches the
    // existing pattern for other connection-referencing tables (see
    // edges, oauth_codes).
    connection_id: text("connection_id").notNull(),
    // The external service's id for this subscription. We retain it so
    // operators can correlate Myme rows with upstream dashboards. Not
    // unique — multiple Myme tenants may target the same external
    // service id in dev environments.
    external_service_id: text("external_service_id"),
    // AES-256-GCM(secret) under HKDF(MYME_AUTH_SECRET,
    // "inbound-webhook-secrets"). Per-row IV is stored in the first 12
    // bytes of the ciphertext — see crypto/secret-encryption.ts.
    secret_encrypted: text("secret_encrypted").notNull(),
    // Verification method stamped at subscription time from the
    // submitted manifest's webhook_verification.method. Each row's
    // dispatch is keyed off this value at receipt.
    verification_method: text("verification_method").notNull(),
    // Non-null when verification_method === 'custom'. WS3 wires
    // resolution; in WS2 the custom adapter is a no-op stub.
    verification_adapter_id: text("verification_adapter_id"),
    events: text("events").notNull().default("[]"),
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

export const inboundWebhookEvents = sqliteTable(
  "inbound_webhook_events",
  {
    id: text("id").primaryKey(),
    inbound_webhook_id: text("inbound_webhook_id").notNull(),
    // The sender's idempotency identifier. Combined with
    // inbound_webhook_id, this enforces at-most-once processing via the
    // unique index below — duplicate POSTs to /webhooks/inbound/:id with
    // the same external_delivery_id collapse to a single row.
    external_delivery_id: text("external_delivery_id").notNull(),
    received_at: text("received_at").notNull(),
    payload: text("payload").notNull(),
    verified: integer("verified").notNull(),
    // NULL = not yet processed. Set when WS3's reactive runner finishes
    // work for this event. Verified-but-not-processed rows are the
    // queue (see idx_inbound_webhook_events_pending).
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
// One row per `system.connection` of kind `integration` whose
// connector authenticates with a token-bearing OAuth grant. The proxy route
// (`POST /connections/:id/proxy/*`) reads from this table, decrypts, and
// stamps `Authorization: Bearer <access>` on the upstream call.
//
// Tokens are encrypted at rest under HKDF(MYME_AUTH_SECRET, info=
// "connection-oauth-tokens"); see crypto/secret-encryption.ts. Hashing won't
// work — the proxy needs the raw token to forward upstream — so this is
// envelope encryption, not one-way digest.
//
// `previous_refresh_hash` enables replay-detection forensics: when we rotate
// (refresh-token grant returns a new refresh_token), we SHA-256 the
// rotated-out token and store it here. If the upstream subsequently rejects
// our refresh attempt with `invalid_grant`, the route flips the connection's
// runtime_status to `reauth_required` and emits a system.activity row.
// ---------------------------------------------------------------------------

export const connectionOauthTokens = sqliteTable(
  "connection_oauth_tokens",
  {
    id: text("id").primaryKey(),
    // FK shape (no DB-level FK, matching project convention) to the
    // `system.connection` item id. Unique — at most one stored token per
    // connection. Re-authorisation overwrites the row in place.
    connection_id: text("connection_id").notNull(),
    tenant_id: text("tenant_id"),
    // AES-256-GCM(plaintext) hex-encoded; see crypto/secret-encryption.ts.
    access_token_encrypted: text("access_token_encrypted").notNull(),
    // Nullable — some OAuth flows (e.g. client_credentials) don't issue a
    // refresh token; the proxy falls back to immediate reauth on 401.
    refresh_token_encrypted: text("refresh_token_encrypted"),
    expires_at: text("expires_at").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    // SHA-256 hex of the most recent rotated-out refresh token. Set when
    // rotation occurs; null on initial authorisation. Forensic only —
    // active enforcement of replay is the upstream's `invalid_grant`.
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
// Short-TTL bearer tokens issued for the four exception cases the OAuth
// proxy doesn't fit (multipart streaming, WebSocket, SDK lock-in, non-HTTP).
// Capability gating ties each lease to a manifest-declared
// `oauth_requirements: { <capability_id>: "leased" }` entry — the lease
// route refuses requests for capabilities the manifest doesn't list.
//
// Storage is hashed (SHA-256) like API keys: the lease IS a bearer token,
// so hashing-on-storage is the right shape. Plaintext is returned ONCE on
// issue. Validation hashes the presented bearer and looks up the row.
//
// Index plan:
//   - unique on lease_token_hash (validation lookup is hash-keyed)
//   - composite on (connection_id, expires_at) for the "active leases for
//     this connection" listing path
// ---------------------------------------------------------------------------

export const connectionLeasedTokens = sqliteTable(
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

export const oauthCodes = sqliteTable("oauth_codes", {
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

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    timestamp: text("timestamp").notNull(),
    key_id: text("key_id"),
    /**
     * Tenant scope (T-041). Stamped from the calling api key's `tenant_id`
     * (or `null` for system-initiated audits / bootstrap-admin keys with no
     * tenant). Reads filter by this column when the caller is tenant-scoped;
     * keys without a tenant (bootstrap admin) see all rows. Indexed because
     * `GET /audit` filters here on every hosted-mode request.
     */
    tenant_id: text("tenant_id"),
    action: text("action").notNull(),
    resource_type: text("resource_type").notNull(),
    resource_id: text("resource_id"),
    details: text("details").notNull().default("{}"),
  },
  (table) => [
    index("idx_audit_log_timestamp").on(table.timestamp),
    index("idx_audit_log_action").on(table.action),
    index("idx_audit_log_resource_type").on(table.resource_type),
    index("idx_audit_log_tenant_id").on(table.tenant_id),
  ],
);

// ---------------------------------------------------------------------------
// settings (generic single-row-per-key KV for workspace-wide flags)
// ---------------------------------------------------------------------------

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ---------------------------------------------------------------------------
// tenant_quotas (T-052: per-tenant resource caps)
// ---------------------------------------------------------------------------

export const tenantQuotas = sqliteTable("tenant_quotas", {
  tenant_id: text("tenant_id").primaryKey(),
  items_limit: integer("items_limit"),
  webhooks_limit: integer("webhooks_limit"),
  blobs_limit: integer("blobs_limit"),
  storage_bytes_limit: integer("storage_bytes_limit"),
  rate_per_minute_limit: integer("rate_per_minute_limit"),
  updated_at: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// email_suppressions (Wave C PR1: per-tenant suppression list)
// ---------------------------------------------------------------------------
//
// See pg/schema.ts for the full design rationale. SQLite mirror —
// composite PK, empty-string sentinel, mirrored from Resend webhooks.
export const emailSuppressions = sqliteTable(
  "email_suppressions",
  {
    tenant_id: text("tenant_id").notNull().default(""),
    email: text("email").notNull(),
    reason: text("reason").notNull(),
    created_at: text("created_at").notNull(),
    source_email_id: text("source_email_id"),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.email] }),
    index("idx_email_suppressions_email").on(table.email),
  ],
);

// ---------------------------------------------------------------------------
// event_log (SSE event persistence for replay)
// ---------------------------------------------------------------------------

export const eventLog = sqliteTable(
  "event_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    event_type: text("event_type").notNull(),
    // Nullable — migration 0014. Edge events store edge_id only; item
    // events store item_id only.
    item_id: text("item_id"),
    edge_id: text("edge_id"),
    tenant_id: text("tenant_id"),
    payload: text("payload").notNull(),
    // Cycle-detection metadata (workstream 2 PR 8). The connection
    // whose action set off this chain of events; null for events
    // originating from a human caller. hop_count starts at 0 on
    // human-initiated events and increments on each reactive
    // publish; pubsub.publish drops events whose hop_count would
    // exceed the tenant's `max_event_hop_budget`.
    originating_connection_id: text("originating_connection_id"),
    hop_count: integer("hop_count").notNull().default(0),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_event_log_created_at").on(table.created_at),
    index("idx_event_log_edge_id").on(table.edge_id),
    // Trace path: events originating from a single connection,
    // ordered by id.
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

// Timestamp columns use `integer({ mode: "timestamp" })` (Unix seconds)
// so the better-auth Drizzle adapter — which forwards JS Date objects —
// can round-trip without manual ISO conversion. Stored as INTEGER under
// the hood; this deviates from myme's TEXT-ISO convention but stays
// localised to the auth_* island.
export const auth_user = sqliteTable(
  "auth_user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    image: text("image"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("idx_auth_user_email").on(table.email)],
);

export const auth_session = sqliteTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
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

export const auth_account = sqliteTable(
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
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_auth_account_user_id").on(table.userId),
    uniqueIndex("idx_auth_account_provider").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const auth_verification = sqliteTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("idx_auth_verification_identifier").on(table.identifier)],
);

// Passkey credentials (one per registered authenticator).
export const auth_passkey = sqliteTable(
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
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    createdAt: integer("created_at", { mode: "timestamp" }),
    aaguid: text("aaguid"),
  },
  (table) => [
    index("idx_auth_passkey_user_id").on(table.userId),
    index("idx_auth_passkey_credential_id").on(table.credentialID),
  ],
);
