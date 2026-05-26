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
  // T-117: operator-controlled tenant status. `'active'` (default) allows
  // writes; `'suspended'` blocks them at the auth middleware. Reads pass
  // through regardless. Platform-admin keys bypass the gate so operators
  // can inspect a suspended tenant.
  status: text("status").notNull().default("active"),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    first_name: text("first_name"),
    last_name: text("last_name"),
    bio: text("bio"),
    avatar_blob_hash: text("avatar_blob_hash"),
    provider: text("provider").notNull(),
    provider_id: text("provider_id").notNull(),
    tenant_id: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    handle: text("handle"),
    auth_user_id: text("auth_user_id").references(() => auth_user.id, {
      onDelete: "set null",
    }),
    /** T-178: principal role projected onto OAuth bearer principals.
     *  Defaults to `member`; operator elevates via SQL until a real
     *  provisioning UI lands. Gates `requireTenantAdmin` /
     *  `requireAdmin` routes for OAuth-authenticated requests. */
    role: text("role").notNull().default("member"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_users_provider").on(table.provider, table.provider_id),
    uniqueIndex("idx_users_handle").on(table.handle),
    uniqueIndex("idx_users_auth_user_id").on(table.auth_user_id),
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

// T-131: oauth_clients + oauth_tokens dropped — replaced by
// auth_oauth_client + auth_oauth_access_token + auth_oauth_refresh_token
// owned by the @better-auth/oauth-provider plugin. See migration
// 0048_drop_legacy_oauth.sql for the drop DDL.

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
    /** T-131: FK previously pointed at the dropped `oauth_clients` table.
     *  Now stores the @better-auth/oauth-provider client_id business key
     *  (auth_oauth_client.client_id) as a plain string — application-
     *  enforced integrity, consistent with the plugin's own cross-table
     *  references. */
    client_id: text("client_id").notNull(),
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
    succeeded: integer("succeeded").notNull().default(0),
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
    // operators can correlate Marfa rows with upstream dashboards. Not
    // unique — multiple Marfa tenants may target the same external
    // service id in dev environments.
    external_service_id: text("external_service_id"),
    // AES-256-GCM(secret) under HKDF(MARFA_AUTH_SECRET,
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
// Tokens are encrypted at rest under HKDF(MARFA_AUTH_SECRET, info=
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

// T-131: oauth_codes dropped — replaced by the
// @better-auth/oauth-provider plugin's authorization code state machine
// (stored in `auth_verification` via the plugin's internal adapter).

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
// bulk_action_jobs (T-218 — see pg/schema.ts for design notes)
// ---------------------------------------------------------------------------

export const bulkActionJobs = sqliteTable(
  "bulk_action_jobs",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id"),
    api_key_id: text("api_key_id"),
    status: text("status").notNull(),
    action: text("action").notNull(),
    input: text("input").notNull(),
    matched_ids: text("matched_ids").notNull(),
    matched_count: integer("matched_count").notNull().default(0),
    processed_count: integer("processed_count").notNull().default(0),
    succeeded_count: integer("succeeded_count").notNull().default(0),
    errored_count: integer("errored_count").notNull().default(0),
    result: text("result"),
    error: text("error"),
    worker_id: text("worker_id"),
    worker_heartbeat_at: text("worker_heartbeat_at"),
    idempotency_key: text("idempotency_key"),
    created_at: text("created_at").notNull(),
    started_at: text("started_at"),
    finished_at: text("finished_at"),
  },
  (table) => [
    index("idx_bulk_action_jobs_status").on(table.status),
    index("idx_bulk_action_jobs_tenant_id").on(table.tenant_id),
    index("idx_bulk_action_jobs_gc").on(table.status, table.finished_at),
    uniqueIndex("idx_bulk_action_jobs_idempotency")
      .on(table.tenant_id, table.idempotency_key)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// rate_limit_windows (T-026 — see pg/schema.ts for design notes)
// ---------------------------------------------------------------------------

export const rateLimitWindows = sqliteTable(
  "rate_limit_windows",
  {
    family: text("family").notNull(),
    window_key: text("window_key").notNull(),
    count: integer("count").notNull(),
    expires_at: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.family, table.window_key] }),
    index("idx_rate_limit_windows_expires_at").on(table.expires_at),
  ],
);

// ---------------------------------------------------------------------------
// settings (generic single-row-per-key KV for instance-wide flags)
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
// Better Auth tables (auth_* prefix, isolated from marfa's own users table)
//
// These are owned and managed by the better-auth library; the schema mirrors
// what `npx @better-auth/cli generate` produces, hand-translated to Drizzle
// for both dialects. Column names use the camelCase keys better-auth expects.
// ---------------------------------------------------------------------------

// Timestamp columns use `integer({ mode: "timestamp" })` (Unix seconds)
// so the better-auth Drizzle adapter — which forwards JS Date objects —
// can round-trip without manual ISO conversion. Stored as INTEGER under
// the hood; this deviates from marfa's TEXT-ISO convention but stays
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
    // T-116: account-lifecycle state. See the PG sibling schema for the
    // full design note. `pending_deletion_at` stays TEXT/ISO to match
    // the rest of marfa's timestamp convention; the purger compares
    // strings without round-tripping through Date.
    deletion_state: text("deletion_state").notNull().default("active"),
    pending_deletion_at: text("pending_deletion_at"),
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

// ---------------------------------------------------------------------------
// @better-auth/oauth-provider plugin tables (T-131)
//
// Four tables owned by the OAuth Provider plugin: client registrations,
// consent grants, opaque access tokens, opaque refresh tokens.
// Naming matches the auth_* convention; the plugin's model→table mapping
// is wired explicitly in `auth/instance.ts` via the `schema` override.
//
// Cross-table foreign keys on `clientId` (the unique business key, not
// the PK `id`) are NOT enforced at the DB level — SQLite supports FKs to
// unique columns but the parity with PG is cleaner if we leave it as
// application-enforced (the plugin's own queries maintain integrity).
// Cascade behavior on auth_user / auth_session is preserved because
// those reference the PK and work in both dialects.
//
// Token columns store the OUTPUT of `storeTokens.hash` — wired in
// `auth/instance.ts` to `hashApiKey(token, salt)` so bearer middleware
// can compute the same value at lookup time.
// ---------------------------------------------------------------------------

export const auth_oauth_client = sqliteTable(
  "auth_oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    /** JSON-encoded string[] — Better Auth adapter serialises */
    scopes: text("scopes"),
    userId: text("user_id").references(() => auth_user.id, {
      onDelete: "cascade",
    }),
    createdAt: integer("created_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    grantTypes: text("grant_types"),
    responseTypes: text("response_types"),
    public: integer("public", { mode: "boolean" }),
    type: text("type"),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    /** Tenant binding from `clientReference` (Marfa: tenant_id). */
    referenceId: text("reference_id"),
    /** JSON object — additional client metadata */
    metadata: text("metadata"),
  },
  (table) => [
    uniqueIndex("idx_auth_oauth_client_client_id").on(table.clientId),
    index("idx_auth_oauth_client_user_id").on(table.userId),
    index("idx_auth_oauth_client_reference_id").on(table.referenceId),
  ],
);

export const auth_oauth_refresh_token = sqliteTable(
  "auth_oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    /** Hashed via `storeTokens.hash` — shares `hashApiKey(token, salt)`
     *  with the bearer middleware so lookup paths are symmetric. */
    token: text("token").notNull(),
    clientId: text("client_id").notNull(),
    sessionId: text("session_id").references(() => auth_session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }),
    /** Single-use marker; plugin rotates on every refresh. Non-null = used. */
    revoked: integer("revoked", { mode: "timestamp" }),
    authTime: integer("auth_time", { mode: "timestamp" }),
    scopes: text("scopes").notNull(),
  },
  (table) => [
    index("idx_auth_oauth_refresh_token_token").on(table.token),
    index("idx_auth_oauth_refresh_token_client_id").on(table.clientId),
    index("idx_auth_oauth_refresh_token_user_id").on(table.userId),
  ],
);

export const auth_oauth_access_token = sqliteTable(
  "auth_oauth_access_token",
  {
    id: text("id").primaryKey(),
    /** Hashed via `storeTokens.hash`. Unique so bearer middleware
     *  can WHERE on it directly. */
    token: text("token").notNull().unique(),
    clientId: text("client_id").notNull(),
    sessionId: text("session_id").references(() => auth_session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => auth_user.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    /** FK to refresh_token.id; cascades so token rotation cleans up. */
    refreshId: text("refresh_id").references(
      () => auth_oauth_refresh_token.id,
      { onDelete: "cascade" },
    ),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }),
    scopes: text("scopes").notNull(),
  },
  (table) => [
    uniqueIndex("idx_auth_oauth_access_token_token").on(table.token),
    index("idx_auth_oauth_access_token_client_id").on(table.clientId),
    index("idx_auth_oauth_access_token_user_id").on(table.userId),
  ],
);

export const auth_oauth_consent = sqliteTable(
  "auth_oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").references(() => auth_user.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    scopes: text("scopes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (table) => [
    // Compound index for the re-consent diff lookup
    // (`/auth/authorize` reads prior consent for this user+client).
    index("idx_auth_oauth_consent_user_client").on(
      table.userId,
      table.clientId,
    ),
    index("idx_auth_oauth_consent_reference_id").on(table.referenceId),
  ],
);

// JWT signing keys (T-131). One row per rotation; the most recent
// non-expired row is the active signer. Used by the @better-auth/jwt
// plugin which the oauth-provider needs for id_token issuance.
export const auth_jwks = sqliteTable("auth_jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
});

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
