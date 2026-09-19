import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    state: text("state").notNull().default("active"),
    tier: text("tier").notNull().default("library"),
    // When the item entered its soft-deleted state, and the honest key for
    // the retention sweep. `updated_at` used to stand in for it and is a
    // proxy for something else: any write to a trashed row moves it, so
    // editing something already in the bin restarted its retention clock
    // with nobody intending to. Tag and extension writes move it too, which
    // widens that to writes nobody thinks of as edits.
    //
    // Stamped when a row moves into the state `softDeleteState` resolves
    // for its type, cleared when it moves back out, so a restore followed
    // by a second delete starts a fresh window rather than inheriting the
    // first one. Nullable because an active row has no such time. The sweep
    // reads it only for rows it has already filtered to the soft-deleted
    // state, and the migration backfills those that predate the column from
    // `updated_at` — the value the sweep was reading anyway, so no row's
    // window moves on the day this lands.
    trashed_at: text("trashed_at"),
    // SQLite's binary JSONB encoding. Write through jsonb(...) and update
    // through jsonb_set (json_set returns text and would silently revert the
    // encoding); read through json(...) — the raw blob is not JSON text.
    properties: blob("properties", { mode: "buffer" }).notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    occurred_at: text("occurred_at").notNull(),
    source: text("source"),
    source_id: text("source_id"),
    version: integer("version").notNull().default(1),
    schema_version: integer("schema_version"),
    device: text("device"),
    capture_latitude: real("capture_latitude"),
    capture_longitude: real("capture_longitude"),
    // The `starts_at` / `ends_at` properties as normalized UTC instants,
    // maintained by the write path. The property is an instant written in
    // whatever offset its upstream used, so comparing those as strings
    // orders `+02:00` against `Z` wrongly and no window predicate can be
    // pushed into SQL. These columns carry the exact shape
    // `Date.prototype.toISOString()` emits, whose fixed width is what
    // makes lexical order and instant order the same thing. Nullable
    // because most items are not events.
    starts_at: text("starts_at"),
    ends_at: text("ends_at"),
  },
  (table) => [
    index("idx_items_type").on(table.type),
    index("idx_items_state").on(table.state),
    index("idx_items_created_at").on(table.created_at),
    index("idx_items_occurred_at").on(table.occurred_at),
    // Serves the catch-up read: "what changed after T", walked in
    // `(updated_at, id)` order. Both halves matter — an index on the
    // column alone answers the predicate and still leaves the sort, and
    // the sort is the expensive half on the read a resuming client makes
    // most often. `id` is in the index rather than left to the ORDER BY,
    // because the keyset cursor compares both to page through the rows
    // that share a millisecond, and a bulk write produces many.
    index("idx_items_updated_at_id").on(table.updated_at, table.id),
    // Provenance identity: one row per upstream record.
    uniqueIndex("idx_items_source_dedup")
      .on(table.source, table.source_id)
      .where(sql`source IS NOT NULL`),
    // Serves the folder query: a folder is a path prefix, so
    // `source_id starts_with 'Notes/'` is a range scan.
    // `COLLATE NOCASE` because an index only serves a prefix match when its
    // collation matches the one the match uses, and SQLite's LIKE is
    // case-insensitive over ASCII. Under a BINARY index the planner declines
    // the range and scans the whole table.
    index("idx_items_source_id_prefix")
      .on(sql`${table.source_id} COLLATE NOCASE`)
      .where(sql`source_id IS NOT NULL`),
    // Serves the calendar's window scan: a range over the normalized start
    // instant. Partial because only events carry one, which keeps the index
    // to the calendar rather than the corpus.
    index("idx_items_starts_at")
      .on(table.starts_at)
      .where(sql`starts_at IS NOT NULL`),
    // Serves the enrichment candidate query, which runs on a timer forever
    // and must cost nothing once a corpus is extracted. Partial: only file
    // items with a blob are ever candidates, ordered as the query reads
    // them: by when the file arrived, because a queue position any write can
    // move is not a record of how long anything has waited. The candidate
    // query inlines these constants as literals — SQLite only uses a partial
    // index when the query provably implies its predicate, and a bound
    // parameter can never be proven.
    index("idx_items_enrichment_candidates")
      .on(table.created_at)
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
    // No FKs on source_id / target_id: an edge may be written before
    // either endpoint resolves, and a cascade has to plan the rows it
    // removes rather than let the engine remove them. The checks run in
    // assertEdgeCanBeCreated + planCascadeDelete.
    source_id: text("source_id").notNull(),
    target_id: text("target_id").notNull(),
    edge_type: text("edge_type").notNull(),
    properties: text("properties").notNull().default("{}"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("idx_edges_source").on(table.source_id, table.edge_type),
    index("idx_edges_target").on(table.target_id, table.edge_type),
    // The edge half of the catch-up read, same shape and same reasoning
    // as `idx_items_updated_at_id`.
    index("idx_edges_updated_at_id").on(table.updated_at, table.id),
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
    key_hash: text("key_hash").notNull().unique(),
    label: text("label").notNull(),
    source: text("source").notNull(),
    default_tier: text("default_tier").notNull().default("library"),
    is_operator: integer("is_operator", { mode: "boolean" })
      .notNull()
      .default(false),
    connection_id: text("connection_id"),
    /**
     * The permissions this credential holds, as a JSON array of the
     * literals themselves.
     *
     * A list rather than a map, because a permission has no read/write
     * axis: it is held or it is not. The same shape a grant carries, so one
     * `hasPermission` answers for a key and for a sign-in.
     *
     * `[]` is the honest default and the right value for an operator key:
     * running the instance is fenced outside the permission model rather than
     * expressed inside it.
     */
    permissions: text("permissions").notNull().default("[]"),
    /**
     * **The wildcard default is legal only on a working key.** An operator
     * row holds nothing on any axis, which `api_keys_operator_holds_nothing`
     * below refuses in bytes, so an operator insert writes `{}` explicitly.
     */
    type_permissions: text("type_permissions")
      .notNull()
      .default('{"*":"write"}'),
    extension_permissions: text("extension_permissions")
      .notNull()
      .default("{}"),
    edge_permissions: text("edge_permissions").notNull().default("{}"),
    metadata_permissions: text("metadata_permissions").notNull().default("{}"),
    /**
     * Per-credential schema-enforcement override, the `EnforcementSettings`
     * shape as JSON, or NULL for a key that inherits the instance config
     * untouched. Read by `resolveEnforcement` beside the instance config at
     * every door that enforces.
     */
    enforcement_override: text("enforcement_override"),
    /**
     * Category 2 of the permission model, Your profile. Keyed on the row
     * (`name`, `email`, `avatar`) with the levelled parent keyed on `*`.
     *
     * A key had nowhere to hold this until now: the field was on the wire type
     * and on the synthetic principal an OAuth grant projects, and a first-party
     * key reached the category through its role instead. With the role gone the
     * map is the only answer, so the column has to exist or no key can ever be
     * granted the category at all.
     */
    profile_permissions: text("profile_permissions").notNull().default("{}"),
    /**
     * The registered client that minted this key, when a signed-in app did.
     * A key minted through a grant belongs to the app that asked for it, so
     * the keys page groups it there and revoking the app offers to revoke it.
     */
    oauth_client_id: text("oauth_client_id"),
    created_at: text("created_at").notNull(),
    // Hard lifetime bound. NULL means the key never expires, which is
    // every key a door mints; a stamped row is refused at the bearer gate
    // once it passes.
    expires_at: text("expires_at"),
    revoked_at: text("revoked_at"),
    last_used_at: text("last_used_at"),
  },
  (table) => [
    uniqueIndex("idx_api_keys_source_unrevoked")
      .on(table.source)
      .where(sql`revoked_at IS NULL`),
    // **The model's one sentence about the instance tier.** The database is
    // what refuses. Declared here so the table definition states the shape
    // it writes into: without it a reader of this file meets the rule for
    // the first time as a driver error naming a constraint nothing in the
    // source mentions.
    //
    // Running the instance is not a permission, so the tier that runs it
    // holds none. Compared as bytes rather than semantically, because SQLite
    // cannot ask an object's size inside a CHECK and the store writes these
    // columns through `JSON.stringify`, so `{}` and `[]` are the exact bytes
    // an empty map and an empty list take. Compared against `1` rather than
    // against the column, because SQLite holds the boolean as an integer.
    check(
      "api_keys_operator_holds_nothing",
      sql`${table.is_operator} <> 1 OR (
        ${table.type_permissions} = '{}' AND
        ${table.edge_permissions} = '{}' AND
        ${table.metadata_permissions} = '{}' AND
        ${table.extension_permissions} = '{}' AND
        ${table.profile_permissions} = '{}' AND
        ${table.permissions} = '[]')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// blobs — one row per content hash; the backend holds one file per hash.
// ---------------------------------------------------------------------------
export const blobs = sqliteTable("blobs", {
  hash: text("hash").primaryKey(),
  mime_type: text("mime_type").notNull(),
  size_bytes: integer("size_bytes").notNull(),
  storage_path: text("storage_path").notNull(),
  // When the blob was registered. The orphan sweep measures its grace
  // window against it, so a blob whose item write is still in flight is not
  // mistaken for one whose item write never landed.
  created_at: text("created_at").notNull(),
});

// The instance's type registrations, the shipped set included.
export const types = sqliteTable(
  "types",
  {
    id: text("id").primaryKey(),
    schema: text("schema").notNull(),
    // Where the type came from, and who may change it. `platform` is the
    // seeded vocabulary and is locked; `connector` belongs to the manifest
    // named in `owner_connector` and only that package may update it;
    // `user` is a registration through the API. `family` carries the split the
    // identifier cannot express (core / connector / system). It began as
    // a property of the shipped set and is written for a connector's
    // own types too, so a row's family says what kind of type it is
    // rather than which build shipped it. Absent for `user` rows, which
    // belong to no platform family and never did.
    origin: text("origin").notNull().default("user"),
    family: text("family"),
    owner_connector: text("owner_connector"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [index("idx_types_origin").on(t.origin)],
);

// The instance's edge-type registrations.
export const edgeTypes = sqliteTable("edge_types", {
  id: text("id").primaryKey(),
  schema: text("schema").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const outboundWebhooks = sqliteTable("outbound_webhooks", {
  id: text("id").primaryKey(),
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
    event_type: text("event_type").notNull(),
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
    // Serves the delivery worker's claim, which is a range over
    // `next_attempt_at` among the rows still pending.
    index("idx_outbound_webhook_deliveries_pending")
      .on(table.next_attempt_at)
      .where(sql`status = 'pending'`),
  ],
);

// oauth_codes is dropped — the @better-auth/oauth-provider plugin's
// authorization code state machine is stored in `auth_verification`
// via the plugin's internal adapter.

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    created_at: text("created_at").notNull(),
    key_id: text("key_id"),
    action: text("action").notNull(),
    resource_type: text("resource_type").notNull(),
    resource_id: text("resource_id"),
    details: text("details").notNull().default("{}"),
  },
  (table) => [
    index("idx_audit_log_created_at").on(table.created_at),
    index("idx_audit_log_action").on(table.action),
    index("idx_audit_log_resource_type").on(table.resource_type),
  ],
);

export const bulkActionJobs = sqliteTable(
  "bulk_action_jobs",
  {
    id: text("id").primaryKey(),
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
    index("idx_bulk_action_jobs_gc").on(table.status, table.finished_at),
    uniqueIndex("idx_bulk_action_jobs_idempotency")
      .on(table.idempotency_key)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

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

export const eventLog = sqliteTable(
  "event_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    event_type: text("event_type").notNull(),
    // Nullable — migration 0014. Edge events store edge_id only; item
    // events store item_id only.
    item_id: text("item_id"),
    edge_id: text("edge_id"),
    payload: text("payload").notNull(),
    // Whether this event drives outbound side effects: webhook delivery and
    // the connector reactions the reactive bridge enqueues. Persisted
    // rather than carried only on the emitted event, because the bridge's
    // drainer is elected across the cluster and may be a different process
    // from the writer — it rebuilds the event from this row, so the
    // instruction has to survive the round trip. Defaults true: that is what
    // every row written before the column did.
    enable_fanout: integer("enable_fanout", { mode: "boolean" })
      .notNull()
      .default(true),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_event_log_created_at").on(table.created_at),
    index("idx_event_log_edge_id").on(table.edge_id),
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
    // match the rest of the time convention; the purger compares
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
    // The plugin's registration writes the client-credentials ceiling on
    // every client it creates, empty for the ones this server registers.
    clientCredentialsScopes: text("client_credentials_scopes"),
    // 1.7 additions, nullable so a 1.6 build serves this schema without
    // noticing. Arrays store as text on this dialect.
    applicationType: text("application_type"),
    backchannelLogoutSessionRequired: integer(
      "backchannel_logout_session_required",
      { mode: "boolean" },
    ),
    backchannelLogoutUri: text("backchannel_logout_uri"),
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
    /** The plugin's own column; nothing here writes it. */
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
     *  the session and loses the record of which one: a sign-out revokes
     *  the token, and the token then outlives the session row. */
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
// The Device Authorization Grant (RFC 8628), owned by the OAuth provider's
// device plugin (`oauthDeviceAuthorization`): it creates the row, claims it
// for the signed-in person, approves or denies it, and consumes it at the
// token endpoint. Marfa reads it for the consent screen and narrows `scope`
// to what the person ticked before approving. `oauth_client_id` and
// `resources` are the provider grant's own fields; the rest is the device
// plugin's model.
export const auth_oauth_device_code = sqliteTable(
  "auth_oauth_device_code",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    status: text("status").notNull(),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp" }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
    oauthClientId: text("oauth_client_id"),
    resources: text("resources"),
  },
  (table) => [
    uniqueIndex("uq_auth_oauth_device_code_device_code").on(table.deviceCode),
    uniqueIndex("uq_auth_oauth_device_code_user_code").on(table.userCode),
  ],
);

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

/**
 * What a write returned, so a client that lost the response can ask.
 *
 * A row is claimed before the write runs and completed with the status and
 * body that went back, so a repeat carrying the same key is answered from
 * here rather than by asking the door again. That distinction is the whole
 * point: a door asked twice answers honestly about the second ask, which is
 * a collision, a version conflict or a missing row depending on the verb,
 * and none of those is the question a retry is asking.
 *
 * `fingerprint` is what makes a repeat a repeat: a digest of the method,
 * path, query, body and calling credential. A key arriving with a different
 * one is refused rather than served, because serving it would silently drop
 * a write the caller believes it made.
 *
 * Rows age out on the event-log retention sweep rather than through a
 * sweeper of their own, which is also what bounds how long a client may
 * wait before retrying and still be told.
 */
export const idempotencyRecords = sqliteTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    idempotency_key: text("idempotency_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    /** `in_flight` while the write runs, `complete` once it answered. */
    state: text("state").notNull(),
    response_status: integer("response_status"),
    response_content_type: text("response_content_type"),
    /** NULL on a completed row means the body was above the store bound. */
    response_body: text("response_body"),
    created_at: text("created_at").notNull(),
    completed_at: text("completed_at"),
  },
  (table) => [
    uniqueIndex("idx_idempotency_records_key").on(table.idempotency_key),
    // Serves the retention sweep, which is a range over `created_at`.
    index("idx_idempotency_records_gc").on(table.created_at),
  ],
);
