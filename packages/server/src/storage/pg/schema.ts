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
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Drizzle has no first-class tsvector type. This customType declares the
// column so the table definition matches the real schema; search reads use
// raw SQL, not Drizzle select.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

// ---------------------------------------------------------------------------
// spaces + users (hosted mode)
// ---------------------------------------------------------------------------

export const spaces = pgTable("spaces", {
  id: text("id").primaryKey(),
  name: text("name"),
  config: jsonb("config"),
  created_at: text("created_at").notNull(),
  // Operator-controlled space status. `'active'` (default) allows writes;
  // `'suspended'` blocks them at the auth middleware. Reads pass through
  // regardless. The operator key bypasses the gate so operators can
  // inspect a suspended space.
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
    space_id: text("space_id")
      .notNull()
      .references(() => spaces.id),
    handle: text("handle"),
    auth_user_id: text("auth_user_id").references(() => auth_user.id, {
      onDelete: "set null",
    }),
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

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey(),
    space_id: text("space_id"),
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
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    timestamp: text("timestamp").notNull(),
    source: text("source"),
    source_id: text("source_id"),
    // The connection that wrote this row (D63). Deliberately NOT part of
    // the natural key: `(source, source_id)` is unchanged, so D34's
    // reinstall adoption still resolves the same row. This column decides
    // only whether a resolved row is *refused*, and is read by the orphan
    // resolver so removing one of two connections marks the removed one's
    // items orphaned rather than leaving them reading live.
    //
    // Nullable with no backfill. Null means no connection is recorded as
    // owning the row: it is adopted and stamped on the next write, which
    // is also what a dead recorded writer does. No foreign key, matching
    // this file's rule that item-to-item references are app-level; no
    // index, because nothing queries *by* writer.
    written_by_connection_id: text("written_by_connection_id"),
    version: integer("version").notNull().default(1),
    schema_version: integer("schema_version"),
    device: text("device"),
    capture_latitude: doublePrecision("capture_latitude"),
    capture_longitude: doublePrecision("capture_longitude"),
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
    // Materialized tsvector populated by the search store at write time.
    // Nullable so backfilled rows can be detected mid-migration. Indexed
    // via GIN below.
    search_vector: tsvector("search_vector"),
  },
  (table) => [
    index("idx_items_type").on(table.type),
    index("idx_items_state").on(table.state),
    index("idx_items_created_at").on(table.created_at),
    index("idx_items_timestamp").on(table.timestamp),
    // Serves the catch-up read: "what changed after T", walked in
    // `(updated_at, id)` order. Both halves matter — an index on the
    // column alone answers the predicate and still leaves the sort, and
    // the sort is the expensive half on the read a resuming client makes
    // most often. `id` is in the index rather than left to the ORDER BY,
    // because the keyset cursor compares both to page through the rows
    // that share a millisecond, and a bulk write produces many.
    //
    // **Not led by `space_id`, and that was measured rather than
    // assumed.** A space-leading composite is the better index for a
    // multi-space deployment and cannot serve a self-host at all:
    // `AUTH_MODE=keys` is the default, nothing carries a space there, so
    // no predicate constrains the leading column and neither planner will
    // walk it for the ordering — the read falls back to a scan plus a
    // sort, which is what this index exists to prevent. Leading on
    // `updated_at` serves both deployment shapes; the space becomes a
    // filter on the rows the walk already visits, bounded by how much
    // changed since T rather than by the size of the corpus. Revisit when
    // one deployment holds enough spaces for that filter to bite, and add
    // the composite alongside rather than instead.
    index("idx_items_updated_at_id").on(table.updated_at, table.id),
    // Provenance identity is per space: two spaces syncing the same
    // integration against the same upstream record are two corpora, not
    // one. COALESCE rather than a plain (space_id, source, source_id)
    // composite because `space_id` is nullable and NULL never equals NULL
    // in a unique index, which would stop deduping the null-space bucket
    // entirely — every row written with no space.
    uniqueIndex("idx_items_source_dedup")
      .on(sql`COALESCE(${table.space_id}, '')`, table.source, table.source_id)
      .where(sql`source IS NOT NULL`),
    // Serves the folder query: a folder is a path prefix, so
    // `source_id starts_with 'Notes/'` is a range scan within a space.
    // `text_pattern_ops` is load-bearing — a btree under a non-C collation
    // sorts in an order the pattern match does not walk, so the default
    // opclass cannot serve LIKE at all.
    index("idx_items_source_id_prefix")
      .on(table.space_id, sql`${table.source_id} text_pattern_ops`)
      .where(sql`source_id IS NOT NULL`),
    // Serves the same folder query under the case-insensitive predicate
    // (LOWER(source_id) LIKE), which a btree on the raw column cannot.
    // Its predecessor above survives until no serving build issues the
    // case-sensitive predicate; a cleanup migration then drops it.
    index("idx_items_source_id_ci_prefix")
      .on(table.space_id, sql`LOWER(${table.source_id}) text_pattern_ops`)
      .where(sql`source_id IS NOT NULL`),
    // Serves the calendar's window scan: a space, then a range over the
    // normalized start instant. Partial because only events carry one,
    // which keeps the index to the calendar rather than the corpus.
    index("idx_items_starts_at_utc")
      .on(table.space_id, table.starts_at_utc)
      .where(sql`starts_at_utc IS NOT NULL`),
    // GIN index on the materialized tsvector. Drizzle-kit emits a
    // standard `CREATE INDEX ... USING gin` statement for this.
    index("idx_items_search_vector").using("gin", table.search_vector),
    // Serves the enrichment candidate query, which runs on a timer forever
    // and must cost nothing once a corpus is extracted. Partial: only file
    // items with a blob are ever candidates, ordered as the query reads
    // them: by when the file arrived, because a queue position any write can
    // move is not a record of how long anything has waited. The candidate
    // query inlines these constants as literals — a bound parameter defeats
    // the planner's partial-index implication proof.
    index("idx_items_enrichment_candidates")
      .on(table.created_at)
      .where(
        sql`(type = 'core.file' OR type LIKE 'core.file.%') AND state <> 'trashed' AND (properties->>'blob_ref') IS NOT NULL`,
      ),
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
    space_id: text("space_id"),
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
    version: integer("version").notNull().default(1),
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
    // The edge half of the catch-up read, same shape and same reasoning
    // as `idx_items_updated_at_id`.
    index("idx_edges_updated_at_id").on(table.updated_at, table.id),
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
    space_id: text("space_id"),
    key_hash: text("key_hash").notNull().unique(),
    label: text("label").notNull(),
    source: text("source").notNull(),
    default_tier: text("default_tier").notNull().default("library"),
    is_operator: boolean("is_operator").notNull().default(false),
    is_runtime_credential: boolean("is_runtime_credential")
      .notNull()
      .default(false),
    connection_id: text("connection_id"),
    item_source: text("item_source"),
    /**
     * The eleven space permissions this credential holds, as a JSON array of
     * the literals themselves.
     *
     * A list rather than a map, because a space permission has no read/write
     * axis: it is held or it is not. The same shape a grant carries, so one
     * `hasSpacePermission` answers for a key and for a sign-in.
     *
     * `[]` is the honest default and the right value for an operator key:
     * running the instance is fenced outside the permission model rather than
     * expressed inside it.
     */
    space_permissions: text("space_permissions").notNull().default("[]"),
    /**
     * **The wildcard default is legal only on a space-bound row.** A row with
     * no space is the operator tier and holds nothing on any axis, which
     * `api_keys_space_less_holds_nothing` below refuses in bytes, so an insert
     * that leaves this column to its default must name a space or the row does
     * not land. Every space-less mint writes `{}` explicitly for that reason.
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
    // **The two halves of the model's one sentence about the instance tier.**
    // The migrations create both, and the database is what refuses. Declared
    // here so the table definition states the shape it writes into: without
    // them a reader of this file meets the rule for the first time as a driver
    // error naming a constraint nothing in the source mentions.
    //
    // A space-less credential is the operator key and nothing else.
    check(
      "api_keys_operator_iff_space_less",
      sql`(${table.space_id} IS NULL) = ${table.is_operator}`,
    ),
    // And running the instance is not a permission, so the tier that runs it
    // holds none. Compared as bytes rather than semantically, because both
    // stores write these columns through `JSON.stringify` and `{}` and `[]`
    // are the exact bytes an empty map and an empty list take.
    check(
      "api_keys_space_less_holds_nothing",
      sql`${table.space_id} IS NOT NULL OR (
        ${table.type_permissions} = '{}' AND
        ${table.edge_permissions} = '{}' AND
        ${table.metadata_permissions} = '{}' AND
        ${table.extension_permissions} = '{}' AND
        ${table.profile_permissions} = '{}' AND
        ${table.space_permissions} = '[]')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// blobs (metadata only — actual files on filesystem)
// ---------------------------------------------------------------------------

// Composite PK on (space_id, hash); empty-string sentinel for instance-wide /
// operator-key and instance-wide rows. See sqlite/schema.ts for rationale.
export const blobs = pgTable(
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
// ---------------------------------------------------------------------------

export const oauthDeviceCodes = pgTable(
  "oauth_device_codes",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the raw device_code returned to the polling client. */
    device_code_hash: text("device_code_hash").notNull().unique(),
    /** Short, low-entropy code displayed to the human (XXXX-XXXX shape). */
    user_code: text("user_code").notNull().unique(),
    /** Stores the plugin's business `client_id` as a plain string
     *  (no FK). */
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

// Custom types are namespaced per space. The composite PK on (space_id, id)
// lets two spaces register the same type id independently — each owns its own
// type vocabulary. `space_id` is NOT NULL DEFAULT '' (empty-string sentinel)
// for platform registrations, mirroring the `blobs`
// and `custom_edge_types` tables.
export const customTypes = pgTable(
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
// is NOT NULL DEFAULT '' (empty-string sentinel) for instance-wide
// self-host / platform registrations, mirroring the `blobs` table.
export const customEdgeTypes = pgTable(
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

// ---------------------------------------------------------------------------
// outbound_webhooks
// ---------------------------------------------------------------------------

export const outboundWebhooks = pgTable("outbound_webhooks", {
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
// inbound_webhooks
// ---------------------------------------------------------------------------

export const inboundWebhooks = pgTable(
  "inbound_webhooks",
  {
    id: text("id").primaryKey(),
    space_id: text("space_id"),
    // App-level reference to a system.connection item (kind:
    // integration). Not a DB-level FK — matches the
    // existing pattern for other connection-referencing tables.
    connection_id: text("connection_id").notNull(),
    // The external service's id for this subscription. Retained for
    // operator correlation; not unique.
    external_service_id: text("external_service_id"),
    // AES-256-GCM(secret) under HKDF(MARFA_AUTH_SECRET,
    // "inbound-webhook-secrets"). Per-row IV is stored in the first 12
    // bytes of the ciphertext — see crypto/secret-encryption.ts.
    secret_encrypted: text("secret_encrypted").notNull(),
    // Verification method stamped at subscription time from the
    // submitted manifest's webhook_verification.method.
    verification_method: text("verification_method").notNull(),
    // Intentionally nullable: only set when verification_method === 'custom',
    // naming the adapter that verifies the signature. The built-in methods
    // (hmac-sha256, slack, stripe, github) are self-describing and leave this
    // undefined — a null here is the normal case, not missing data.
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
// inbound_webhook_events
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
    // NULL = not yet processed. The reactive runner stamps this when
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
// connection_oauth_tokens
//
// Mirror of the SQLite table; see sqlite/schema.ts for the design notes.
// ---------------------------------------------------------------------------

export const connectionOauthTokens = pgTable(
  "connection_oauth_tokens",
  {
    id: text("id").primaryKey(),
    connection_id: text("connection_id").notNull(),
    space_id: text("space_id"),
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
// connection_leased_tokens
//
// Mirror of the SQLite table; see sqlite/schema.ts for the design notes.
// ---------------------------------------------------------------------------

export const connectionLeasedTokens = pgTable(
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

// oauth_codes was dropped — replaced by @better-auth/oauth-provider's auth code state machine.

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
     * Space scope. Stamped from the calling api key's `space_id`, and null
     * when there was no space to stamp: system-initiated audits, and the
     * operator key. What can be read back is decided by `GET /audit`, which
     * takes the `space.audit_read` space permission and then filters on the
     * caller's own space.
     *
     * **A null here is not a key to the whole trail.** The operator key is
     * the only api key row that may be space-less, and a space-less row holds
     * no space permission at all, so that gate refuses it before this column
     * is consulted. Indexed because the filter runs on every hosted-mode
     * request.
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

// ---------------------------------------------------------------------------
// bulk_action_jobs (async substrate for /items/bulk-actions)
// ---------------------------------------------------------------------------

// Job rows for the async bulk_action endpoint. POST /items/bulk-actions
// (non-dry-run) inserts a row; the in-process worker picks it up via
// SELECT ... FOR UPDATE SKIP LOCKED, runs the action in batched-SQL
// chunks, writes progress to processed_count / succeeded_count /
// errored_count, then writes the final BulkActionResult envelope to
// `result` and flips status to a terminal value.
//
// `matched_ids` is the frozen-at-create-time list of item ids the
// worker iterates; the route's pagination phase resolves the filter
// once so the worker doesn't re-evaluate it. `input` is the original
// BulkActionInput for replay / debugging / audit.
//
// `idempotency_key` carries the optional `Idempotency-Key` header — a
// partial unique index (space_id, idempotency_key) lets replayed POSTs
// resolve to the same job row.
//
// GC: completed / failed / cancelled rows expire after
// BULK_ACTION_JOB_RETENTION_MS (default 7 days). Index on
// (status, finished_at) backs the sweep query.
export const bulkActionJobs = pgTable(
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
    // NULLS NOT DISTINCT is applied by a migration because Drizzle's
    // uniqueIndex builder doesn't expose .nullsNotDistinct() yet — only
    // `unique()` constraints carry it, and those don't support WHERE.
    // Without it, two replays from a space-less credential
    // (space_id IS NULL) wouldn't conflict on the (NULL, key) pair
    // because PG defaults treat NULLs as distinct in unique indexes.
    // Idempotency would silently double-fire for the admin path.
    // When drizzle-orm grows the API, fold this back into the declaration.
    uniqueIndex("idx_bulk_action_jobs_idempotency")
      .on(table.space_id, table.idempotency_key)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// rate_limit_windows (cluster-shared rate-limit + throttle counters)
// ---------------------------------------------------------------------------

// Single table backing two consumers:
//   - `rate-limit middleware` (family = "rate") — per-credential and
//     per-space request windows. Window keys are
//     "<credential-id-or-ip>:<path-prefix>" and "space:<space-id>".
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
// `expires_at` is TEXT/ISO to stay consistent with the rest of marfa's
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
// settings (generic single-row-per-key KV for instance-wide flags)
// ---------------------------------------------------------------------------

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ---------------------------------------------------------------------------
// space_quotas (per-space resource caps)
// ---------------------------------------------------------------------------

export const spaceQuotas = pgTable("space_quotas", {
  space_id: text("space_id").primaryKey(),
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
    // uses string serialization (`String(id)` and `BigInt(Last-Event-ID)`)
    // which both round-trip cleanly.
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    event_type: text("event_type").notNull(),
    // item events set item_id; edge events set edge_id. Both nullable (relaxed in migration 0014).
    item_id: text("item_id"),
    edge_id: text("edge_id"),
    space_id: text("space_id"),
    payload: text("payload").notNull(),
    originating_connection_id: text("originating_connection_id"),
    hop_count: integer("hop_count").notNull().default(0),
    // Whether this event drives outbound side effects: webhook delivery and
    // the integration reactions the reactive bridge enqueues. Persisted
    // rather than carried only on the emitted event, because the bridge's
    // drainer is elected across the cluster and may be a different process
    // from the writer — it rebuilds the event from this row, so the
    // instruction has to survive the round trip. Defaults true: that is what
    // every row written before the column did.
    enable_fanout: boolean("enable_fanout").notNull().default(true),
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
// Better Auth tables (auth_* prefix, isolated from marfa's own users table)
//
// These are owned and managed by the better-auth library; the schema mirrors
// what `npx @better-auth/cli generate` produces, hand-translated to Drizzle
// for both dialects. Column names use the camelCase keys better-auth expects.
// ---------------------------------------------------------------------------

// Timestamp columns use `timestamp({ mode: "date" })` — better-auth's Drizzle
// adapter forwards JS Dates. Deviates from Marfa's TEXT-ISO convention but
// stays localized to the auth_* island.
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
    // Account-lifecycle state. `'active'` (default) is the normal state;
    // `'pending_deletion'` is set on confirm of a delete-account request
    // and triggers the `PendingDeletePurger` hard-delete sweep after the
    // grace window elapses. `pending_deletion_at` is the ISO timestamp
    // stamped on confirm (NULL while active); the purger compares
    // `pending_deletion_at + grace_days < now()` to gate the cascade.
    // The TEXT/ISO shape on `pending_deletion_at` deviates from the auth_*
    // island's timestamp(mode:date) convention because the column is read
    // by the purger (`storage/retention.ts`) and the route layer, both of
    // which work in ISO strings throughout.
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
    // 1.7 keys account lookups on (issuer, account_id): local credential
    // accounts carry `local:credential`, OAuth identities a namespaced
    // provider form. Nullable so a 1.6 build can still insert during the
    // deploy window; the migration backfills, and the deploy re-runs the
    // backfill after the roll for any row minted inside the window.
    issuer: text("issuer"),
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
    uniqueIndex("idx_auth_account_issuer_account_id").on(
      table.issuer,
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
// @better-auth/oauth-provider plugin tables
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
    // 1.7 additions, nullable so a 1.6 build serves this schema without
    // noticing. The library reads its own registration surface from
    // these; nothing in Marfa writes them yet.
    applicationType: text("application_type"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    clientDiscoveryId: text("client_discovery_id"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
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
    /** Space binding from `clientReference` (Marfa: space_id). */
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
    /** Same as `auth_oauth_access_token.session_id` below, including the
     *  `set null` and what it costs. */
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
    // 1.7 additions, all nullable so a 1.6 build serves this schema
    // without noticing. The rotation columns carry the library's own
    // replay handling for a rotated token presented twice.
    authorizationCodeId: text("authorization_code_id"),
    confirmation: jsonb("confirmation"),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    resources: text("resources").array(),
    rotatedAt: timestamp("rotated_at", { mode: "date" }),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", {
      mode: "date",
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

export const auth_oauth_access_token = pgTable(
  "auth_oauth_access_token",
  {
    id: text("id").primaryKey(),
    /** Hashed via `storeTokens.hash`. Unique so bearer middleware
     *  can WHERE on it directly. */
    token: text("token").notNull().unique(),
    clientId: text("client_id").notNull(),
    /** The session this token was issued under, and what a sign-out matches
     *  on to revoke it.
     *
     *  `set null`, not `cascade`, so the token row survives the session and
     *  can still be read. The cost is that it survives with no memory of what
     *  it was issued under: deleting the session erases the only evidence the
     *  link ever existed. A later reader finding a null here cannot tell an
     *  orphaned token from one that never carried a session at all, and that
     *  is exactly how a ticket came to be filed claiming session-scoped
     *  revocation did not work. It does; the forensic trail is what does not
     *  survive. Observed end to end on 23 August 2026: a bearer that answered
     *  200 returned 401 after a sign-out on its issuing session. */
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
    // 1.7 additions, all nullable so a 1.6 build serves this schema
    // without noticing. `resources` is what binds a token to the
    // audience its grant covered.
    authorizationCodeId: text("authorization_code_id"),
    confirmation: jsonb("confirmation"),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    resources: text("resources").array(),
    revoked: timestamp("revoked", { mode: "date" }),
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
    // 1.7 additions, nullable so a 1.6 build serves this schema without
    // noticing.
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    resources: text("resources").array(),
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

// JWT signing keys. See sqlite/schema.ts for the rationale.
export const auth_jwks = pgTable("auth_jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }),
  // 1.7 records which algorithm a key pair was minted for, and the curve
  // for EC/OKP keys, so verification can select among heterogeneous keys.
  // Nullable: rows minted under 1.6 predate the columns, and the library
  // reads null as its configured default algorithm.
  alg: text("alg"),
  crv: text("crv"),
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

// Deterministic-enrichment bookkeeping: one row per file item the text
// sweeper has looked at, keyed by item id. Lives in its own table rather
// than in item properties so bookkeeping writes never mint version
// snapshots or fan out item events. The candidate query anti-joins this
// table by its PK and drives off `items` via the partial
// idx_items_enrichment_candidates index — the items side is what needed
// indexing, a fact the original claim here got wrong. A `blob_ref` change
// or an `extractor_version` bump re-admits the item; `attempts` bounds
// retries of failing blobs. Hard-deleting the item deletes the row.
export const enrichmentState = pgTable("enrichment_state", {
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
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    space_id: text("space_id"),
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
    // COALESCE rather than a plain (space_id, idempotency_key) composite,
    // mirroring `idx_items_source_dedup`: `space_id` is nullable and NULL
    // never equals NULL in a unique index, so the plain shape would stop
    // deduping the null-space bucket entirely — every request on a
    // instance-wide bucket, and every operator-key request anywhere.
    // The same defect was found and repaired on `bulk_action_jobs`, which
    // reached for NULLS NOT DISTINCT instead; COALESCE says it once and is
    // the same expression in both dialects.
    uniqueIndex("idx_idempotency_records_key").on(
      sql`COALESCE(${table.space_id}, '')`,
      table.idempotency_key,
    ),
    // Serves the retention sweep, which is a range over `created_at`
    // within a space scope.
    index("idx_idempotency_records_gc").on(table.space_id, table.created_at),
  ],
);
