import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  name: text("name"),
  config: text("config"),
  created_at: text("created_at").notNull(),
  // Operator-controlled space status. `'active'` (default) allows writes;
  // `'suspended'` blocks them at the auth middleware. Reads pass through
  // regardless. Platform-admin keys bypass the gate so operators can
  // inspect a suspended space.
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
    space_id: text("space_id")
      .notNull()
      .references(() => spaces.id),
    handle: text("handle"),
    auth_user_id: text("auth_user_id").references(() => auth_user.id, {
      onDelete: "set null",
    }),
    /** Principal role projected onto OAuth bearer principals. Defaults
     *  to `member`; operator elevates via SQL until a provisioning UI
     *  lands. Gates `requireSpaceAdmin` / `requireAdmin` routes for
     *  OAuth-authenticated requests. */
    role: text("role").notNull().default("member"),
    /** IANA zone the account keeps its own clock in. A default and a
     *  display preference: it answers "what is on today" for a caller
     *  that names no zone, and never anchors a recurrence. */
    timezone: text("timezone"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_users_provider").on(table.provider, table.provider_id),
    uniqueIndex("idx_users_handle").on(table.handle),
    uniqueIndex("idx_users_auth_user_id").on(table.auth_user_id),
  ],
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    space_id: text("space_id"),
    type: text("type").notNull(),
    state: text("state").notNull().default("active"),
    tier: text("tier").notNull().default("library"),
    // SQLite's binary JSONB encoding. Write through jsonb(...) and update
    // through jsonb_set (json_set returns text and would silently revert the
    // encoding); read through json(...) — the raw blob is not JSON text.
    properties: blob("properties", { mode: "buffer" }).notNull(),
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
    // The `starts_at` / `ends_at` properties as normalized UTC instants,
    // maintained by the write path. Stored times are instants written in
    // whatever offset their upstream used, so comparing them as strings
    // orders `+02:00` against `Z` wrongly and no window predicate can be
    // pushed into SQL. These carry the exact shape
    // `Date.prototype.toISOString()` emits, whose fixed width is what
    // makes lexical order and instant order the same thing. Nullable
    // because most items are not events.
    starts_at_utc: text("starts_at_utc"),
    ends_at_utc: text("ends_at_utc"),
  },
  (table) => [
    index("idx_items_type").on(table.type),
    index("idx_items_state").on(table.state),
    index("idx_items_created_at").on(table.created_at),
    index("idx_items_timestamp").on(table.timestamp),
    // Provenance identity is per space: two spaces syncing the same
    // integration against the same upstream record are two corpora, not
    // one. COALESCE rather than a plain (space_id, source, source_id)
    // composite because `space_id` is nullable and NULL never equals NULL
    // in a unique index, which would stop deduping the null-space bucket
    // entirely — every row on a single-space self-host.
    uniqueIndex("idx_items_source_dedup")
      .on(sql`COALESCE(${table.space_id}, '')`, table.source, table.source_id)
      .where(sql`source IS NOT NULL`),
    // Serves the folder query: a folder is a path prefix, so
    // `source_id starts_with 'Notes/'` is a range scan within a space.
    // `COLLATE NOCASE` is the counterpart to the Postgres side's
    // `text_pattern_ops` — an index only serves a prefix match when its
    // collation matches the one the match uses, and SQLite's LIKE is
    // case-insensitive over ASCII. Under a BINARY index the planner declines
    // the range and scans the whole space.
    index("idx_items_source_id_prefix")
      .on(table.space_id, sql`${table.source_id} COLLATE NOCASE`)
      .where(sql`source_id IS NOT NULL`),
    // Serves the calendar's window scan: a space, then a range over the
    // normalized start instant. Partial because only events carry one,
    // which keeps the index to the calendar rather than the corpus.
    index("idx_items_starts_at_utc")
      .on(table.space_id, table.starts_at_utc)
      .where(sql`starts_at_utc IS NOT NULL`),
    // Serves the enrichment candidate query, which runs on a timer forever
    // and must cost nothing once a corpus is extracted. Partial: only file
    // items with a blob are ever candidates, ordered as the query reads
    // them. The candidate query inlines these constants as literals —
    // SQLite only uses a partial index when the query provably implies its
    // predicate, and a bound parameter can never be proven.
    index("idx_items_enrichment_candidates")
      .on(table.updated_at)
      .where(
        sql`(type = 'core.file' OR type LIKE 'core.file.%') AND state <> 'trashed' AND json_extract(properties, '$.blob_ref') IS NOT NULL`,
      ),
  ],
);

// metadata: 1:1 sidecar for items
export const metadata = sqliteTable("metadata", {
  item_id: text("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  tags: text("tags").notNull().default("[]"),
  extensions: text("extensions").notNull().default("{}"),
});

export const edges = sqliteTable(
  "edges",
  {
    id: text("id").primaryKey(),
    space_id: text("space_id"),
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
      table.space_id,
      table.source_id,
      table.edge_type,
    ),
    index("idx_edges_target").on(
      table.space_id,
      table.target_id,
      table.edge_type,
    ),
  ],
);

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

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    space_id: text("space_id"),
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
    item_source: text("item_source"),
    type_permissions: text("type_permissions")
      .notNull()
      .default('{"*":"write"}'),
    extension_permissions: text("extension_permissions")
      .notNull()
      .default("{}"),
    edge_permissions: text("edge_permissions").notNull().default("{}"),
    metadata_permissions: text("metadata_permissions").notNull().default("{}"),
    created_at: text("created_at").notNull(),
    // Hard lifetime bound. NULL means the key never expires (human-minted
    // keys); runtime credentials are always stamped so the bearer gate and
    // the reaper can retire them without an explicit revoke.
    expires_at: text("expires_at"),
    revoked_at: text("revoked_at"),
    last_used_at: text("last_used_at"),
  },
  (table) => [
    uniqueIndex("idx_api_keys_source_per_space")
      .on(table.space_id, table.source)
      .where(sql`revoked_at IS NULL`),
    // Every reaper pass and the metrics counter filter on
    // `is_runtime_credential` first. Partial on true: the runtime-credential
    // slice is the only one anything scans by this column, and human keys are
    // a rounding error beside a week of dispatch volume.
    index("idx_api_keys_runtime_credential")
      .on(table.is_runtime_credential)
      .where(sql`is_runtime_credential`),
  ],
);

// ---------------------------------------------------------------------------
// blobs
//
// Blob rows are per-space. The same `hash` can appear under multiple
// space_ids; the file system / S3 backend dedupes physically (one file
// per hash), but the blobs table carries one row per (space_id, hash) so
// cross-space reads of `/blobs/:hash` resolve to the caller's row only —
// missing for a given space means 404.
//
// `space_id` is `NOT NULL DEFAULT ''` rather than nullable to keep the
// composite PK simple. Empty string `''` is the sentinel for
// "instance-wide / no space" — used by single-space self-hosts and by
// platform-admin uploads in hosted mode where the credential carries no
// space_id. The empty-string-as-sentinel asymmetry vs other tables (which
// use nullable `space_id`) is intentional: composite PKs with nullable
// columns behave inconsistently across SQLite and PG, and this table is
// the only place we need a composite primary identity.
export const blobs = sqliteTable(
  "blobs",
  {
    space_id: text("space_id").notNull().default(""),
    hash: text("hash").notNull(),
    mime_type: text("mime_type").notNull(),
    size: integer("size").notNull(),
    storage_path: text("storage_path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.space_id, t.hash] })],
);

// ---------------------------------------------------------------------------
// oauth_device_codes — Device Authorization Grant (RFC 8628)
//
// OAuth client + token storage is owned by the @better-auth/oauth-provider
// plugin (auth_oauth_client + auth_oauth_access_token +
// auth_oauth_refresh_token). See migration 0048_drop_legacy_oauth.sql.
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
    /** Stores the @better-auth/oauth-provider client_id business key
     *  (auth_oauth_client.client_id) as a plain string — application-
     *  enforced integrity, consistent with the plugin's own cross-table
     *  references (no FK). */
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

// Custom types are namespaced per space. The composite PK on (space_id, id)
// lets two spaces register the same type id independently — each owns its own
// type vocabulary. `space_id` is NOT NULL DEFAULT '' (empty-string sentinel)
// for single-space self-host / platform registrations, mirroring the `blobs`
// and `custom_edge_types` tables.
export const customTypes = sqliteTable(
  "custom_types",
  {
    space_id: text("space_id").notNull().default(""),
    id: text("id").notNull(),
    schema: text("schema").notNull(),
    // Where the type came from, and who may change it. `platform` is the
    // seeded vocabulary and is locked; `integration` belongs to the manifest
    // named in `owner_integration` and only that package may update it;
    // `user` is a registration through the API. `family` carries the split the
    // identifier cannot express (core / integration / system). It began as
    // a property of the shipped set and is written for an integration's
    // own types too, so a row's family says what kind of type it is
    // rather than which build shipped it. Absent for `user` rows, which
    // belong to no platform family and never did.
    origin: text("origin").notNull().default("user"),
    family: text("family"),
    owner_integration: text("owner_integration"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.space_id, t.id] })],
);

// Custom edge types are namespaced per space. The composite PK on
// (space_id, id) lets two spaces register the same edge-type id
// independently — each owns its own relationship vocabulary. `space_id`
// is NOT NULL DEFAULT '' (empty-string sentinel) for single-space
// self-host / platform registrations, mirroring the `blobs` table.
export const customEdgeTypes = sqliteTable(
  "custom_edge_types",
  {
    space_id: text("space_id").notNull().default(""),
    id: text("id").notNull(),
    schema: text("schema").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.space_id, t.id] })],
);

export const outboundWebhooks = sqliteTable("outbound_webhooks", {
  id: text("id").primaryKey(),
  space_id: text("space_id"),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: text("events").notNull().default("[]"),
  type_filter: text("type_filter"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

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

export const inboundWebhooks = sqliteTable(
  "inbound_webhooks",
  {
    id: text("id").primaryKey(),
    space_id: text("space_id"),
    // App-level reference to a system.connection item (kind:
    // integration). Not a DB-level FK — matches the
    // existing pattern for other connection-referencing tables (see
    // edges, oauth_codes).
    connection_id: text("connection_id").notNull(),
    // The external service's id for this subscription. We retain it so
    // operators can correlate Marfa rows with upstream dashboards. Not
    // unique — multiple Marfa spaces may target the same external
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
    // Intentionally nullable: only set when verification_method === 'custom',
    // naming the adapter that resolves the handler at dispatch time. The
    // built-in methods (hmac-sha256, slack, stripe, github) are self-describing
    // and leave this undefined — a null here is the normal case, not missing data.
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
    // NULL = not yet processed. Set when the reactive runner finishes
    // work for this event. Verified-but-not-processed rows are the
    // pending queue (see idx_inbound_webhook_events_pending).
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
// connection_oauth_tokens
//
// One row per `system.connection` of kind `integration` whose
// integration authenticates with a token-bearing OAuth grant. The proxy route
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
    // connection. Re-authorization overwrites the row in place.
    connection_id: text("connection_id").notNull(),
    space_id: text("space_id"),
    // AES-256-GCM(plaintext) hex-encoded; see crypto/secret-encryption.ts.
    access_token_encrypted: text("access_token_encrypted").notNull(),
    // Nullable — some OAuth flows (e.g. client_credentials) don't issue a
    // refresh token; the proxy falls back to immediate reauth on 401.
    refresh_token_encrypted: text("refresh_token_encrypted"),
    expires_at: text("expires_at").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    // SHA-256 hex of the most recent rotated-out refresh token. Set when
    // rotation occurs; null on initial authorization. Forensic only —
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
// connection_leased_tokens
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
    space_id: text("space_id"),
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

// oauth_codes is dropped — the @better-auth/oauth-provider plugin's
// authorization code state machine is stored in `auth_verification`
// via the plugin's internal adapter.

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    timestamp: text("timestamp").notNull(),
    key_id: text("key_id"),
    /**
     * Space scope. Stamped from the calling api key's `space_id`
     * (or `null` for system-initiated audits / bootstrap-admin keys with no
     * space). Reads filter by this column when the caller is space-scoped;
     * keys without a space (bootstrap admin) see all rows. Indexed because
     * `GET /audit` filters here on every hosted-mode request.
     */
    space_id: text("space_id"),
    action: text("action").notNull(),
    resource_type: text("resource_type").notNull(),
    resource_id: text("resource_id"),
    details: text("details").notNull().default("{}"),
  },
  (table) => [
    index("idx_audit_log_timestamp").on(table.timestamp),
    index("idx_audit_log_action").on(table.action),
    index("idx_audit_log_resource_type").on(table.resource_type),
    index("idx_audit_log_space_id").on(table.space_id),
  ],
);

// bulk_action_jobs: see pg/schema.ts for design notes
export const bulkActionJobs = sqliteTable(
  "bulk_action_jobs",
  {
    id: text("id").primaryKey(),
    space_id: text("space_id"),
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
    index("idx_bulk_action_jobs_space_id").on(table.space_id),
    index("idx_bulk_action_jobs_gc").on(table.status, table.finished_at),
    uniqueIndex("idx_bulk_action_jobs_idempotency")
      .on(table.space_id, table.idempotency_key)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

// rate_limit_windows: see pg/schema.ts for design notes
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

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const spaceQuotas = sqliteTable("space_quotas", {
  space_id: text("space_id").primaryKey(),
  items_limit: integer("items_limit"),
  webhooks_limit: integer("webhooks_limit"),
  blobs_limit: integer("blobs_limit"),
  storage_bytes_limit: integer("storage_bytes_limit"),
  rate_per_minute_limit: integer("rate_per_minute_limit"),
  updated_at: text("updated_at").notNull(),
});

export const eventLog = sqliteTable(
  "event_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    event_type: text("event_type").notNull(),
    // Nullable — migration 0014. Edge events store edge_id only; item
    // events store item_id only.
    item_id: text("item_id"),
    edge_id: text("edge_id"),
    space_id: text("space_id"),
    payload: text("payload").notNull(),
    // Cycle-detection metadata: the connection whose action set off this
    // chain of events; null for events originating from a human caller.
    // hop_count starts at 0 on human-initiated events and increments on
    // each reactive publish; pubsub.publish drops events whose hop_count
    // would exceed the space's `max_event_hop_budget`.
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
// Owned and managed by better-auth; mirrors `npx @better-auth/cli generate`,
// hand-translated to Drizzle for both dialects. Column names use the camelCase
// keys better-auth expects.
//
// Timestamp columns use `integer({ mode: "timestamp" })` (Unix seconds) so
// the Drizzle adapter — which forwards JS Date objects — can round-trip without
// manual ISO conversion. Deviates from marfa's TEXT-ISO convention but stays
// localized to the auth_* island.
// ---------------------------------------------------------------------------
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
    // Account-lifecycle state. `pending_deletion_at` stays TEXT/ISO to
    // match the rest of the timestamp convention; the purger compares
    // strings without round-tripping through Date. See pg/schema.ts for
    // the full design note.
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
    // 1.7 keys account lookups on (issuer, account_id) — see the pg
    // sibling for the reasoning. Nullable for the deploy window.
    issuer: text("issuer"),
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
    uniqueIndex("idx_auth_account_issuer_account_id").on(
      table.issuer,
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
// @better-auth/oauth-provider plugin tables
//
// Four tables: client registrations, consent grants, opaque access tokens,
// opaque refresh tokens. Model→table mapping wired in `auth/instance.ts`.
//
// FKs on `clientId` (the business key, not the PK) are application-enforced —
// SQLite supports FKs to unique columns but leaving them out keeps parity with
// PG cleaner. Cascade behavior on auth_user / auth_session is preserved where
// those reference the PK.
//
// Token columns store the OUTPUT of `storeTokens.hash` (wired to
// `hashApiKey(token, salt)`) so bearer middleware can compute the same value.
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
    /** JSON-encoded string[] — Better Auth adapter serializes */
    scopes: text("scopes"),
    // 1.7 additions, nullable so a 1.6 build serves this schema without
    // noticing. Arrays store as text on this dialect.
    applicationType: text("application_type"),
    backchannelLogoutSessionRequired: integer(
      "backchannel_logout_session_required",
      { mode: "boolean" },
    ),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    clientCredentialsScopes: text("client_credentials_scopes"),
    clientDiscoveryId: text("client_discovery_id"),
    dpopBoundAccessTokens: integer("dpop_bound_access_tokens", {
      mode: "boolean",
    }),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
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
    /** Space binding from `clientReference` (Marfa: space_id). */
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
    /** Same as `auth_oauth_access_token.session_id` below, including the
     *  `set null` and what it costs. */
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
    // 1.7 additions, all nullable so a 1.6 build serves this schema
    // without noticing. Arrays and json store as text on this dialect.
    authorizationCodeId: text("authorization_code_id"),
    confirmation: text("confirmation"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    resources: text("resources"),
    rotatedAt: integer("rotated_at", { mode: "timestamp" }),
    rotationReplayExpiresAt: integer("rotation_replay_expires_at", {
      mode: "timestamp",
    }),
    rotationReplayResponse: text("rotation_replay_response"),
  },
  (table) => [
    index("idx_auth_oauth_refresh_token_token").on(table.token),
    index("idx_auth_oauth_refresh_token_client_id").on(table.clientId),
    index("idx_auth_oauth_refresh_token_user_id").on(table.userId),
    index("idx_auth_oauth_refresh_token_authorization_code_id").on(
      table.authorizationCodeId,
    ),
    // The session-delete hook queries this column on every sign-out, and the
    // auth plugin's own declared schema marks it indexed. This side had
    // silently diverged from that declaration, so every sign-out ran a
    // sequential scan of both token tables.
    index("idx_auth_oauth_refresh_token_session_id").on(table.sessionId),
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
    /** The session this token was issued under, and what a sign-out matches
     *  on to revoke it. `set null` rather than `cascade`, so the row outlives
     *  the session and loses the record of which one. See the note on the
     *  Postgres side of this column for why that matters. */
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
    // 1.7 additions, all nullable so a 1.6 build serves this schema
    // without noticing. Arrays and json store as text on this dialect.
    authorizationCodeId: text("authorization_code_id"),
    confirmation: text("confirmation"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    resources: text("resources"),
    revoked: integer("revoked", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("idx_auth_oauth_access_token_token").on(table.token),
    index("idx_auth_oauth_access_token_client_id").on(table.clientId),
    index("idx_auth_oauth_access_token_user_id").on(table.userId),
    index("idx_auth_oauth_access_token_authorization_code_id").on(
      table.authorizationCodeId,
    ),
    // The session-delete hook queries this column on every sign-out, and the
    // auth plugin's own declared schema marks it indexed. This side had
    // silently diverged from that declaration, so every sign-out ran a
    // sequential scan of both token tables.
    index("idx_auth_oauth_access_token_session_id").on(table.sessionId),
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
    // 1.7 additions, nullable; arrays store as text on this dialect.
    requestedUserInfoClaims: text("requested_user_info_claims"),
    resources: text("resources"),
  },
  (table) => [
    // One consent row per user-client pair. The OAuth Provider plugin's
    // consent endpoint resolves a prior grant and updates in place, but
    // its lookup keys on (clientId, userId, referenceId), so a re-consent
    // that resolves a different referenceId would otherwise insert a
    // duplicate. The idempotent adapter wrapper upserts on this pair; the
    // constraint is the backstop against a concurrent double-insert.
    uniqueIndex("uq_auth_oauth_consent_client_user").on(
      table.clientId,
      table.userId,
    ),
    index("idx_auth_oauth_consent_reference_id").on(table.referenceId),
  ],
);

// JWT signing keys. One row per rotation; the most recent non-expired
// row is the active signer. Used by the @better-auth/jwt plugin which
// the oauth-provider needs for id_token issuance.
export const auth_jwks = sqliteTable("auth_jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  // 1.7 key-algorithm columns — see the pg sibling for the reasoning.
  alg: text("alg"),
  crv: text("crv"),
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

// Deterministic-enrichment bookkeeping: one row per file item the text
// sweeper has looked at, keyed by item id. Lives in its own table rather
// than in item properties so bookkeeping writes never mint version
// snapshots or fan out item events. The candidate query anti-joins this
// table by its PK and drives off `items` via the partial
// idx_items_enrichment_candidates index — the items side is what needed
// indexing, a fact the original claim here got wrong. A `blob_ref` change
// or an `extractor_version` bump re-admits the item; `attempts` bounds
// retries of failing blobs. Hard-deleting the item deletes the row.
export const enrichmentState = sqliteTable("enrichment_state", {
  item_id: text("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  space_id: text("space_id"),
  blob_ref: text("blob_ref").notNull(),
  extractor_version: integer("extractor_version").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  // The configuration signature the row was last written under. A skip is
  // terminal only relative to the settings that produced it; the candidate
  // query re-offers skipped rows whose stamp differs from the sweeper's
  // current one. Nullable: rows predating the column re-offer once.
  config_signature: text("config_signature"),
  updated_at: text("updated_at").notNull(),
});
