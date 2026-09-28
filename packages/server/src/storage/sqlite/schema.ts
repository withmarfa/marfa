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
    // When the item entered its soft-deleted state, and the retention
    // sweep's key. `updated_at` cannot be that key: any write to a trashed
    // row moves it, tag and extension writes included, so an edit made in
    // the bin would restart the retention clock.
    //
    // Stamped when a row moves into the state `softDeleteState` resolves
    // for its type, cleared when it moves back out, so a restore followed
    // by a second delete starts a fresh window rather than inheriting the
    // first one. Nullable because an active row has no such time.
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

// Which rows a trash took with it through a cascading edge, so restoring
// the row named brings them back and leaves alone a row trashed on its own.
// A row leaves this table when it leaves the bin, by restore or transition,
// and with either end when it is purged.
export const trash_cascades = sqliteTable(
  "trash_cascades",
  {
    item_id: text("item_id")
      .primaryKey()
      .references(() => items.id, { onDelete: "cascade" }),
    trashed_with: text("trashed_with")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
  },
  (table) => [index("idx_trash_cascades_with").on(table.trashed_with)],
);

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
    // The three item fields an update may change that are not properties.
    // A three-way merge needs the value at the version the client read, or
    // it cannot tell the client having changed a field from somebody else
    // having changed it, and has to take the client's value blind.
    tier: text("tier"),
    occurred_at: text("occurred_at"),
    source_id: text("source_id"),
    // And the type, so a stale move can tell whether the row was moved
    // since the version the caller read. `REQUIRED_COLUMNS` in
    // `connection.ts` refuses a file whose table lacks it.
    type: text("type").notNull(),
    created_at: text("created_at").notNull(),
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
    /**
     * The sources a write by this key may name besides its own, as a JSON
     * array of strings. Not unique across keys, unlike `source`: two keys
     * claiming one source is how two devices present one natural key.
     */
    sources: text("sources").notNull().default("[]"),
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
     * (`name`, `email`, `avatar`) with the leveled parent keyed on `*`.
     *
     * The map is the only answer for a key, which holds no role that could
     * reach the category instead, so the column has to exist or no key can
     * ever be granted it at all.
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
        ${table.permissions} = '[]' AND
        ${table.sources} = '[]')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// blobs — one row per content hash. Where the bytes are is the location
// log's business, not this row's.
// ---------------------------------------------------------------------------
export const blobs = sqliteTable("blobs", {
  hash: text("hash").primaryKey(),
  mime_type: text("mime_type").notNull(),
  size_bytes: integer("size_bytes").notNull(),
  // When the blob was registered; replication copies in this order, so a
  // backlog drains oldest first.
  created_at: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// blob_stores — every place bytes live that this instance has attached.
//
// A store's id comes from a marker the store itself holds, not from the
// configuration that named it, so a fresh folder is a fresh store with no
// claimed copies. A row whose store the configuration no longer names is
// kept and marked detached rather than deleted: the location log still
// describes it, and a copy count that forgot a store could never be wrong
// in the safe direction.
// ---------------------------------------------------------------------------
export const blobStores = sqliteTable("blob_stores", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  // Where the store is, for a person: a directory, or a bucket and prefix.
  // Never a credential.
  locator: text("locator").notNull(),
  // What the store wants to hold. `all` is the one policy this build
  // defines; the column is open for the presets a store that wants less
  // will name.
  policy: text("policy").notNull().default("all"),
  attached_at: text("attached_at").notNull(),
  detached_at: text("detached_at"),
});

// ---------------------------------------------------------------------------
// blob_locations — the location log: which stores hold which blob.
//
// A row is written only once the store has the bytes and they hashed to
// their name; `verified_at` is the last time a check found the copy present
// and intact, null until one has. A copy counts only while its store is
// still attached.
// ---------------------------------------------------------------------------
export const blobLocations = sqliteTable(
  "blob_locations",
  {
    hash: text("hash")
      .notNull()
      .references(() => blobs.hash, { onDelete: "cascade" }),
    store_id: text("store_id")
      .notNull()
      .references(() => blobStores.id),
    recorded_at: text("recorded_at").notNull(),
    verified_at: text("verified_at"),
  },
  (table) => [
    primaryKey({ columns: [table.hash, table.store_id] }),
    // The integrity check takes a store's least recently checked copies.
    index("idx_blob_locations_store_verified").on(
      table.store_id,
      table.verified_at,
    ),
  ],
);

// ---------------------------------------------------------------------------
// blob_orphans — the report that stands between an unreferenced blob and its
// deletion. A run of the orphan sweep writes every blob nothing references
// here with the time it was first reported, drops any referenced again, and
// purges only what an earlier run reported longer ago than the grace.
// ---------------------------------------------------------------------------
export const blobOrphans = sqliteTable("blob_orphans", {
  hash: text("hash")
    .primaryKey()
    .references(() => blobs.hash, { onDelete: "cascade" }),
  reported_at: text("reported_at").notNull(),
});

// The instance's type registrations, the shipped set included.
export const types = sqliteTable(
  "types",
  {
    id: text("id").primaryKey(),
    schema: text("schema").notNull(),
    // Where the type came from, and who may change it. `platform` is the
    // seeded vocabulary and is locked; `user` is a registration through the
    // API; `unknown` is a restored row whose archive recorded none. `family`
    // is the seed's (core or system), the split the lifecycle keys on;
    // absent on a registration, which belongs to no platform family.
    origin: text("origin").notNull().default("user"),
    family: text("family"),
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

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    created_at: text("created_at").notNull(),
    key_id: text("key_id"),
    action: text("action").notNull(),
    resource_type: text("resource_type").notNull(),
    resource_id: text("resource_id"),
    client_ip: text("client_ip"),
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
    // Nullable, and separately so: `publish` stamps `item_id`, `publishEdge`
    // stamps `edge_id`, and neither column is constrained. A row holding
    // neither is therefore storable, which is not hypothetical — two
    // fixtures in `events-type-filter.test.ts` append one on purpose, so the
    // stream has to decide about it rather than assume it away. `events.ts`
    // reads a null `edge_id` as an item event, which withholds such a row,
    // and those fixtures are what pin it.
    item_id: text("item_id"),
    edge_id: text("edge_id"),
    payload: text("payload").notNull(),
    // Whether this event drives outbound side effects — webhook delivery.
    // Persisted rather than carried only on the emitted event, because a
    // catch-up rebuilds the event from this row: without the column a
    // replayed event would read as fanning out when its writer said
    // otherwise. Defaults true, so a row appended without naming it fans
    // out, which is what every ordinary write door wants.
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
// Better Auth tables (auth_* prefix)
//
// Owned and managed by better-auth; mirrors `npx @better-auth/cli generate`,
// hand-translated to Drizzle. Column names use the camelCase
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
    // Better Auth keys account lookups on (issuer, account_id).
    issuer: text("issuer").notNull(),
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
// Client registrations, consent grants, opaque access tokens, opaque refresh
// tokens and device codes. Model→table mapping wired in `auth/instance.ts`.
//
// FKs on `clientId` (the business key, not the PK) are application-enforced.
// Cascade behavior on auth_user / auth_session is preserved where those
// reference the PK.
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
    // Nullable, as the plugin declares them. Arrays store as text.
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
    // Nullable, as the plugin declares them. Arrays and json store as text.
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
    // The session-delete hook queries this column on every sign-out, and
    // the auth plugin's own declared schema marks it indexed; without the
    // index every sign-out scans both token tables.
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
    // Nullable, as the plugin declares them. Arrays and json store as text.
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
    // The session-delete hook queries this column on every sign-out, and
    // the auth plugin's own declared schema marks it indexed; without the
    // index every sign-out scans both token tables.
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
    // Nullable, as the plugin declares them; arrays store as text.
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

// JWT signing keys. One row per rotation; the most recent non-expired
// row is the active signer. Used by the @better-auth/jwt plugin which
// the oauth-provider needs for id_token issuance.
export const auth_jwks = sqliteTable("auth_jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
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
// idx_items_enrichment_candidates index, the items side being what the
// query needs indexed. A `blob_ref` change
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
  // current one.
  config_signature: text("config_signature").notNull(),
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

// ---------------------------------------------------------------------------
// housekeeping — the server's own periodic work, one row per housekeeping
// job.
//
// The row is the schedule and the record in one: the scheduler polls it for
// names whose `next_run_at` has passed, claims one by setting `running_since`
// where it is null (SQLite's single writer makes that claim exclusive), and
// writes the outcome back when the run ends. `next_run_at` survives a
// restart, so a daily sweep that ran two hours before a deploy runs in
// twenty-two hours rather than at boot.
// ---------------------------------------------------------------------------
export const housekeeping = sqliteTable("housekeeping", {
  name: text("name").primaryKey(),
  interval_ms: integer("interval_ms").notNull(),
  next_run_at: text("next_run_at").notNull(),
  /** Set while a run holds the name; a value found at boot was left by a
   *  run the last process never finished. */
  running_since: text("running_since"),
  last_started_at: text("last_started_at"),
  last_finished_at: text("last_finished_at"),
  /** `ok` or `error`. */
  last_outcome: text("last_outcome"),
  last_error: text("last_error"),
  /** JSON: whatever the last run reported. */
  last_result: text("last_result"),
});

// ---------------------------------------------------------------------------
// connectors: a process outside the server that registered under its key,
// and the runs it reported. The key is the identity, one registration per
// key. Nothing here runs or supervises anything; a reader decides what a
// stale heartbeat or a failed run means.
// ---------------------------------------------------------------------------
export const connectors = sqliteTable("connectors", {
  id: text("id").primaryKey(),
  key_id: text("key_id").notNull().unique(),
  /** The key's own source when it registered, which its writes carry unless they name a claim. */
  source: text("source").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  registered_at: text("registered_at").notNull(),
  updated_at: text("updated_at").notNull(),
  last_heartbeat_at: text("last_heartbeat_at"),
});

export const connectorRuns = sqliteTable(
  "connector_runs",
  {
    id: text("id").primaryKey(),
    connector_id: text("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    /** `succeeded` or `failed`. */
    outcome: text("outcome").notNull(),
    started_at: text("started_at").notNull(),
    finished_at: text("finished_at").notNull(),
    summary: text("summary"),
    error: text("error"),
    reported_at: text("reported_at").notNull(),
  },
  (table) => [
    // The listing and the trim both take a connector's newest runs.
    index("idx_connector_runs_connector_reported").on(
      table.connector_id,
      table.reported_at,
    ),
  ],
);

export const inboundEndpoints = sqliteTable(
  "inbound_endpoints",
  {
    id: text("id").primaryKey(),
    connector_id: text("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    /** A SHA-256 of the address's token; the token itself is never stored. */
    token_hash: text("token_hash").notNull().unique(),
    token_last4: text("token_last4").notNull(),
    label: text("label"),
    /** The header whose value names a delivery, lowercased. */
    duplicate_header: text("duplicate_header"),
    created_at: text("created_at").notNull(),
    retired_at: text("retired_at"),
  },
  (table) => [index("idx_inbound_endpoints_connector").on(table.connector_id)],
);

export const inboundDeliveries = sqliteTable(
  "inbound_deliveries",
  {
    id: text("id").primaryKey(),
    endpoint_id: text("endpoint_id")
      .notNull()
      .references(() => inboundEndpoints.id, { onDelete: "cascade" }),
    connector_id: text("connector_id").notNull(),
    received_at: text("received_at").notNull(),
    method: text("method").notNull(),
    query: text("query").notNull(),
    /** `[name, value]` pairs in the order and case they arrived. */
    headers: text("headers").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    dedupe_key: text("dedupe_key"),
    handled_at: text("handled_at"),
    /** `processed`, `duplicate` or `rejected`, once handled. */
    outcome: text("outcome"),
  },
  (table) => [
    // The listing and the backlog count both read a connector's deliveries
    // by whether they are handled, oldest first.
    index("idx_inbound_deliveries_connector_handled").on(
      table.connector_id,
      table.handled_at,
      table.received_at,
      table.id,
    ),
    index("idx_inbound_deliveries_endpoint_dedupe").on(
      table.endpoint_id,
      table.dedupe_key,
    ),
    index("idx_inbound_deliveries_received").on(table.received_at),
  ],
);

export const inboundDeliveryBodies = sqliteTable("inbound_delivery_bodies", {
  delivery_id: text("delivery_id")
    .primaryKey()
    .references(() => inboundDeliveries.id, { onDelete: "cascade" }),
  body: blob("body", { mode: "buffer" }).notNull(),
});

export const connectorHolds = sqliteTable("connector_holds", {
  connector_id: text("connector_id")
    .primaryKey()
    .references(() => connectors.id, { onDelete: "cascade" }),
  process: text("process").notNull(),
  held_until: text("held_until").notNull(),
});

// Keyed by source rather than registration, so a key minted later under the
// same source finds what its predecessor kept.
export const connectorStates = sqliteTable("connector_states", {
  source: text("source").primaryKey(),
  state: text("state").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const connectorAgreements = sqliteTable(
  "connector_agreements",
  {
    source: text("source").notNull(),
    item_id: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    waiting: integer("waiting", { mode: "boolean" }).notNull(),
    record: text("record").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.item_id] }),
    index("idx_connector_agreements_waiting").on(
      table.source,
      table.waiting,
      table.updated_at,
      table.item_id,
    ),
    index("idx_connector_agreements_updated").on(
      table.source,
      table.updated_at,
      table.item_id,
    ),
    // A purge's cascade finds a row's agreements by the row alone.
    index("idx_connector_agreements_item").on(table.item_id),
  ],
);
