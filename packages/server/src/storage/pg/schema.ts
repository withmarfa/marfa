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
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// T-015: Drizzle doesn't have a first-class tsvector type, so we
// declare a small customType. We never SELECT the column directly
// (search reads use raw SQL via the unsafe path); declaring it lets
// `drizzle-kit generate` emit the right migration shape and lets the
// item-store INSERTs reference it.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

// ---------------------------------------------------------------------------
// tenants + users (hosted mode)
// ---------------------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name"),
  config: jsonb("config"),
  created_at: text("created_at").notNull(),
  // T-117: operator-controlled tenant status. `'active'` (default) allows
  // writes; `'suspended'` blocks them at the auth middleware. Reads pass
  // through regardless. Platform-admin keys bypass the gate so operators
  // can inspect a suspended tenant.
  status: text("status").notNull().default("active"),
});

export const users = pgTable(
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
     *  provisioning UI lands. Gates `requireWorkspaceAdmin` /
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
    version: integer("version").notNull().default(1),
    schema_version: integer("schema_version"),
    device: text("device"),
    capture_latitude: doublePrecision("capture_latitude"),
    capture_longitude: doublePrecision("capture_longitude"),
    // T-015: materialised tsvector populated by the search store at
    // write time. Nullable so backfilled rows can be detected
    // mid-migration. Indexed via GIN below.
    search_vector: tsvector("search_vector"),
  },
  (table) => [
    index("idx_items_type").on(table.type),
    index("idx_items_state").on(table.state),
    index("idx_items_created_at").on(table.created_at),
    index("idx_items_timestamp").on(table.timestamp),
    uniqueIndex("idx_items_source_dedup")
      .on(table.source, table.source_id)
      .where(sql`source IS NOT NULL`),
    // GIN index on the materialised tsvector. Drizzle-kit emits a
    // standard `CREATE INDEX ... USING gin` statement for this.
    index("idx_items_search_vector").using("gin", table.search_vector),
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

// T-049: see sqlite/schema.ts for the full design rationale. Composite
// PK on (tenant_id, hash); empty-string sentinel for instance-wide /
// platform-admin / single-tenant rows.
export const blobs = pgTable(
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
// 0055_drop_legacy_oauth.sql for the drop DDL.

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
    /** T-131: FK previously pointed at the dropped `oauth_clients` table.
     *  Now stores the plugin's business `client_id` as a plain string. */
    client_id: text("client_id").notNull(),
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
    // integration). Not a DB-level FK — matches the
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

// T-131: oauth_codes dropped — replaced by the
// @better-auth/oauth-provider plugin's authorization code state machine.

// ---------------------------------------------------------------------------
// audit_log (append-only audit trail)
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
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
// rate_limit_windows (T-026: cluster-shared rate-limit + throttle counters)
// ---------------------------------------------------------------------------

// Single table backing two consumers:
//   - `rate-limit middleware` (family = "rate") — per-credential and
//     per-tenant request windows. Window keys are
//     "<credential-id-or-ip>:<path-prefix>" and "tenant:<tenant-id>".
//   - `forgot-password per-email throttle` (family = "throttle") —
//     window key "forgot-password:<lowercased-email>", window 1h.
//
// Each row is upserted atomically (`INSERT ... ON CONFLICT DO UPDATE`)
// so two server instances pointed at the same DB share counters
// cluster-wide. Expired rows (`expires_at < now()`) are GC'd by the
// `RateLimitWindowCleaner` retention sweep.
//
// Composite PK on (family, window_key) keeps the two consumer surfaces
// in one physical table without risk of key collisions across families.
// `expires_at` is TEXT/ISO to stay consistent with the rest of myme's
// timestamp convention; lexicographic comparison works for cutoff sweeps.
export const rateLimitWindows = pgTable(
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
// settings (generic single-row-per-key KV for workspace-wide flags)
// ---------------------------------------------------------------------------

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ---------------------------------------------------------------------------
// tenant_quotas (T-052: per-tenant resource caps)
// ---------------------------------------------------------------------------

export const tenantQuotas = pgTable("tenant_quotas", {
  tenant_id: text("tenant_id").primaryKey(),
  items_limit: integer("items_limit"),
  webhooks_limit: integer("webhooks_limit"),
  blobs_limit: integer("blobs_limit"),
  storage_bytes_limit: bigint("storage_bytes_limit", { mode: "number" }),
  rate_per_minute_limit: integer("rate_per_minute_limit"),
  updated_at: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// event_log (SSE event persistence for replay)
// ---------------------------------------------------------------------------

export const eventLog = pgTable(
  "event_log",
  {
    // BIGINT, not INT4: event_log is append-only and INT4 (~2.1B) is a
    // foreseeable wrap. `mode: "bigint"` (not "number") because the
    // underlying column is an i64 — `mode: "number"` would silently
    // truncate above 2^53. Consumers (event-log-store.ts, routes/events.ts,
    // pubsub.ts) handle the value as a `bigint` end-to-end; the SSE wire
    // uses string serialisation (`String(id)` and `BigInt(Last-Event-ID)`)
    // which both round-trip cleanly.
    id: bigint("id", { mode: "bigint" })
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
    // T-116: account-lifecycle state. `'active'` (default) is the normal
    // state; `'pending_deletion'` is set on confirm of a delete-account
    // request and triggers the `PendingDeletePurger` hard-delete sweep
    // after the grace window elapses. `pending_deletion_at` is the ISO
    // timestamp stamped on confirm (NULL while active); the purger
    // compares `pending_deletion_at + grace_days < now()` to gate the
    // cascade. The TEXT/ISO shape on `pending_deletion_at` deviates
    // from the auth_* island's timestamp(mode:date) convention because
    // the column is read by the purger (`storage/retention.ts`) and the
    // route layer, both of which work in ISO strings throughout.
    deletion_state: text("deletion_state").notNull().default("active"),
    pending_deletion_at: text("pending_deletion_at"),
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

// ---------------------------------------------------------------------------
// @better-auth/oauth-provider plugin tables (T-131)
//
// Four tables owned by the OAuth Provider plugin: client registrations,
// consent grants, opaque access tokens, opaque refresh tokens.
// Naming matches the auth_* convention; the plugin's model→table mapping
// is wired explicitly in `auth/instance.ts` via the `schema` override.
//
// Cross-table foreign keys on `clientId` (the unique business key, not
// the PK `id`) are NOT enforced at the DB level for dialect-parity with
// SQLite — the plugin's own queries maintain integrity. FKs on user_id /
// session_id reference PKs and work in both dialects.
//
// Token columns store the OUTPUT of `storeTokens.hash` — wired in
// `auth/instance.ts` to `hashApiKey(token, salt)` so bearer middleware
// can compute the same value at lookup time.
// ---------------------------------------------------------------------------

export const auth_oauth_client = pgTable(
  "auth_oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    disabled: boolean("disabled").notNull().default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    // Plugin-declared `string[]` fields: the @better-auth Drizzle adapter
    // sets `supportsArrays: true` for PG, so these must be native PG
    // arrays (`text[]`). Plain `text` columns silently JSON-stringify on
    // insert and return strings on read, which breaks the plugin's
    // `client.redirectUris?.find(...)` callers with a TypeError.
    scopes: text("scopes").array(),
    userId: text("user_id").references(() => auth_user.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { mode: "date" }),
    updatedAt: timestamp("updated_at", { mode: "date" }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("require_pkce"),
    /** Tenant binding from `clientReference` (Myme: tenant_id). */
    referenceId: text("reference_id"),
    /** JSON object — additional client metadata */
    metadata: jsonb("metadata"),
  },
  (table) => [
    uniqueIndex("idx_auth_oauth_client_client_id").on(table.clientId),
    index("idx_auth_oauth_client_user_id").on(table.userId),
    index("idx_auth_oauth_client_reference_id").on(table.referenceId),
  ],
);

export const auth_oauth_refresh_token = pgTable(
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
    expiresAt: timestamp("expires_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }),
    /** Single-use marker; plugin rotates on every refresh. Non-null = used. */
    revoked: timestamp("revoked", { mode: "date" }),
    authTime: timestamp("auth_time", { mode: "date" }),
    // Plugin-declared `string[]` field — see the comment on
    // `auth_oauth_client.scopes` for the rationale.
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("idx_auth_oauth_refresh_token_token").on(table.token),
    index("idx_auth_oauth_refresh_token_client_id").on(table.clientId),
    index("idx_auth_oauth_refresh_token_user_id").on(table.userId),
  ],
);

export const auth_oauth_access_token = pgTable(
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
    expiresAt: timestamp("expires_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }),
    // Plugin-declared `string[]` field — see the comment on
    // `auth_oauth_client.scopes` for the rationale.
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    uniqueIndex("idx_auth_oauth_access_token_token").on(table.token),
    index("idx_auth_oauth_access_token_client_id").on(table.clientId),
    index("idx_auth_oauth_access_token_user_id").on(table.userId),
  ],
);

export const auth_oauth_consent = pgTable(
  "auth_oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").references(() => auth_user.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    // Plugin-declared `string[]` field — see the comment on
    // `auth_oauth_client.scopes` for the rationale.
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }),
    updatedAt: timestamp("updated_at", { mode: "date" }),
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

// JWT signing keys (T-131). See sqlite/schema.ts for the rationale.
export const auth_jwks = pgTable("auth_jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }),
});

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
