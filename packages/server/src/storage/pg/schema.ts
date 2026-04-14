import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  jsonb,
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
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_users_provider").on(table.provider, table.provider_id),
  ],
);

// ---------------------------------------------------------------------------
// threads (defined first because items references it)
// ---------------------------------------------------------------------------

export const threads = pgTable("threads", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

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
    library: boolean("library").notNull().default(false),
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
    // source_id and target_id are NOT foreign keys to items(id). Most edges
    // point between items, but the in-thread edge type targets rows in the
    // threads table during the V0 legacy thread-API window (see edge-
    // constraints.ts). FKs would reject those. App-level existence checks
    // run in assertEdgeCanBeCreated; orphan-edge cleanup on item delete is
    // handled by planCascadeDelete + explicit edgeStore.deleteBySource /
    // deleteByTarget calls.
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
    default_library: boolean("default_library").notNull().default(false),
    type_permissions: text("type_permissions")
      .notNull()
      .default('{"*":"write"}'),
    extension_permissions: text("extension_permissions")
      .notNull()
      .default("{}"),
    edge_permissions: text("edge_permissions").notNull().default("{}"),
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

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    client_id: text("client_id")
      .notNull()
      .references(() => oauthClients.id),
    scopes: text("scopes").notNull().default("[]"),
    created_at: text("created_at").notNull(),
  },
  (table) => [index("idx_oauth_grants_client_id").on(table.client_id)],
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    grant_id: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id),
    token_hash: text("token_hash").notNull().unique(),
    token_type: text("token_type").notNull(),
    expires_at: text("expires_at").notNull(),
    revoked_at: text("revoked_at"),
    used_at: text("used_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_oauth_tokens_grant_id").on(table.grant_id),
    index("idx_oauth_tokens_token_hash").on(table.token_hash),
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
// webhooks
// ---------------------------------------------------------------------------

export const webhooks = pgTable("webhooks", {
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
// webhook_deliveries
// ---------------------------------------------------------------------------

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
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
  (table) => [index("idx_webhook_deliveries_webhook_id").on(table.webhook_id)],
);

export const oauthCodes = pgTable("oauth_codes", {
  id: text("id").primaryKey(),
  grant_id: text("grant_id")
    .notNull()
    .references(() => oauthGrants.id),
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
// event_log (SSE event persistence for replay)
// ---------------------------------------------------------------------------

export const eventLog = pgTable(
  "event_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    event_type: text("event_type").notNull(),
    // Nullable: item events set item_id and leave edge_id null; edge
    // events set edge_id and leave item_id null. Relaxed from NOT NULL
    // in migration 0014.
    item_id: text("item_id"),
    edge_id: text("edge_id"),
    tenant_id: text("tenant_id"),
    payload: text("payload").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_event_log_created_at").on(table.created_at),
    index("idx_event_log_edge_id").on(table.edge_id),
  ],
);
