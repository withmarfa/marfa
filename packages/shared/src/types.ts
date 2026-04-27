// Myme types — the wire format for the Myme API.
// These interfaces define what goes over the network between server and clients.

import type { ItemState, MergePolicy } from "@mymehq/types";

/** Valid item states as a readonly array, useful for validation. */
export const ITEM_STATES: readonly ItemState[] = [
  "active",
  "archived",
  "trashed",
  "revoked",
] as const;

/**
 * Authorship class of an item's content. `system` is reserved for items the
 * server creates internally (notably `system.*` items like devices,
 * credentials, webhooks, and registered apps); callers cannot stamp it.
 */
export type Origin = "user" | "ai" | "worker" | "system";

/** Valid origin values as a readonly array, useful for validation. */
export const ORIGINS: readonly Origin[] = [
  "user",
  "ai",
  "worker",
  "system",
] as const;

/**
 * The intent tier on an item — `library` is curated, kept, indexed; `feed`
 * is high-volume, low-intent capture. Items move between them through manual
 * or automated curation. `system.*` items have no tier (the dimension does
 * not apply); the field is optional on the wire to model that.
 */
export type Tier = "library" | "feed";

/** Valid tier values as a readonly array, useful for validation. */
export const TIERS: readonly Tier[] = ["library", "feed"] as const;

/** API key roles. */
export type KeyRole = "admin" | "member";

/** Per-type permission levels. */
export type TypePermission = "read" | "write" | "none";

/** Per-namespace extension permission levels. */
export type ExtensionPermission = "read" | "write";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A Myme item — the fundamental data record. */
export interface Item {
  id: string;
  type: string;
  state: ItemState;
  /**
   * The intent tier on this item — `library` is curated/kept, `feed` is
   * high-volume capture. Optional because `system.*` items have no tier.
   */
  tier?: Tier;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  timestamp: string;
  source: string;
  source_id?: string;
  origin: Origin;
  version: number;
  schema_version: number;
  device?: string;
  capture_latitude?: number;
  capture_longitude?: number;
}

/** Input for creating a new item. */
export interface CreateItemInput {
  type: string;
  properties: Record<string, unknown>;
  id?: string;
  state?: ItemState;
  /** Overrides the credential's default_tier when supplied. */
  tier?: Tier;
  timestamp?: string;
  /** Ignored on the wire — server always stamps source from the credential. */
  source?: string;
  source_id?: string;
  origin?: Origin;
  device?: string;
  capture_latitude?: number;
  capture_longitude?: number;
  tags?: string[];
}

/** Input for updating an existing item. */
export interface UpdateItemInput {
  properties?: Record<string, unknown>;
  version?: number;
  snapshot?: boolean;
  /** Toggle the tier (`library` ↔ `feed`). Independent of the version-merge
   *  path for `properties`; flipping `tier` doesn't conflict (it's a single
   *  metadata-axis flag, last-writer-wins by design). */
  tier?: Tier;
  /** Override the user-meaningful timestamp. Settable on create; this
   *  field lets importers fix dates retroactively without rewriting
   *  properties. Independent of the version-merge path. */
  timestamp?: string;
}

/** An item paired with its metadata sidecar. */
export interface ItemWithMetadata {
  item: Item;
  metadata: Metadata;
}

/** Metadata sidecar — tags and namespaced extensions. About / entity
 *  references are carried as first-class `about` edges; read via
 *  `item.edges.about` or `/items/:id/edges?edge_type=about`. */
export interface Metadata {
  item_id: string;
  tags: string[];
  extensions: Record<string, Record<string, unknown>>;
}

/** A frozen snapshot of an item's previous state. */
export interface Version {
  id: string;
  item_id: string;
  version: number;
  properties: Record<string, unknown>;
  created_at: string;
  device?: string;
}

// ---------------------------------------------------------------------------
// Edges — first-class typed relationships between items
// ---------------------------------------------------------------------------

/**
 * A typed edge between two items. Direction is spec-exact: source is the
 * "from" side of the relationship, target is the "to" side. See
 * Myme v0 Reference §Relationships for semantics per edge type.
 */
export interface Edge {
  id: string;
  tenant_id?: string | null;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Input for creating a new edge. */
export interface CreateEdgeInput {
  source_id: string;
  target_id: string;
  edge_type: string;
  properties?: Record<string, unknown>;
  /** Explicit id override (otherwise server-generated UUIDv7). */
  id?: string;
}

/** Input for updating an existing edge (properties only — direction/type immutable). */
export interface UpdateEdgeInput {
  properties: Record<string, unknown>;
}

/**
 * Hydrated edges block attached to an item response — one entry per edge
 * type pointing out from (or into) this item. Truncated per-type with
 * a pagination cursor.
 */
export interface ItemEdgesBlock {
  edges: Edge[];
  has_more: boolean;
  next_cursor?: string;
}

/** Per-edge-type permission levels. */
export type EdgePermission = "read" | "write";

/** An API key record (without the key value itself). */
export interface ApiKey {
  id: string;
  tenant_id?: string;
  label: string;
  /** Human-readable display name stamped onto items this credential writes. */
  source: string;
  role: KeyRole;
  /**
   * Platform-credential gate (TSC42 §3/§4). When `true`, the credential may
   * register and write `core.*`, `system.*`, and `myme.*` types. The first
   * credential created at server install is the seed platform credential;
   * only an existing platform credential may mint another. Defaults to
   * `false` for ordinary tenant admin and member keys.
   */
  is_platform: boolean;
  /** Origin stamped onto items when the client doesn't supply one.
   *  `system` is excluded — server-stamped only, never a credential default. */
  default_origin: Exclude<Origin, "system">;
  /** Tier stamped onto items when the client doesn't supply one. */
  default_tier: Tier;
  type_permissions: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  /**
   * Per-edge-type permissions map. Keyed by edge type id (`parent-of`,
   * `about`, `karakeep.list-member`, …) or `*` for wildcard. Empty object
   * means no edge permissions granted — non-admin keys with no entries
   * cannot create/update/delete edges (reads fall back to the source
   * item's type_permissions).
   */
  edge_permissions?: Record<string, EdgePermission>;
  created_at: string;
  last_used_at: string | null;
}

/** Input for creating a new API key. */
export interface CreateKeyInput {
  label: string;
  source: string;
  role: KeyRole;
  default_origin?: Exclude<Origin, "system">;
  default_tier?: Tier;
  type_permissions?: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  edge_permissions?: Record<string, EdgePermission>;
  /**
   * Optional. Only an existing platform credential can set this to `true`;
   * other callers see the value silently coerced to `false`. The bootstrap
   * admin created at server install is the seed platform credential.
   */
  is_platform?: boolean;
}

/**
 * Input for in-place updating an API key (PATCH). All fields optional;
 * `source` and `role` are intentionally omitted — they are immutable after
 * creation (source is baked into item provenance, role is security-critical).
 */
export interface UpdateKeyInput {
  label?: string;
  default_origin?: Exclude<Origin, "system">;
  default_tier?: Tier;
  type_permissions?: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  edge_permissions?: Record<string, EdgePermission>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** Cursor-based paginated response. */
export interface PaginatedResult<T> {
  data: T[];
  cursor: string | null;
  has_more: boolean;
}

/** A search result with relevance scoring. */
export interface SearchResult {
  item: Item;
  metadata: Metadata;
  relevance_score: number;
  /** HTML snippet with `<mark>` tags highlighting matched terms. */
  snippet_html?: string;
  /** @deprecated Use `snippet_html` instead. Contains the same HTML content. */
  snippet?: string;
}

/** Standard error response body. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Conflict resolution types (enriched 409 response)
// ---------------------------------------------------------------------------

/** A snapshot of an item's version and properties, used in conflict responses. */
export interface ConflictSnapshot {
  version: number;
  properties: Record<string, unknown>;
}

/** Enriched 409 conflict response — the server produces this, the SDK consumes it. */
export interface ConflictResponse {
  error: { code: "version_conflict"; status: 409 };
  current: ConflictSnapshot;
  ancestor: ConflictSnapshot;
  conflicting_fields: string[];
  /**
   * Resolved merge policy for the conflicting item's type, with inheritance
   * applied. Always present — the server is the authoritative resolver, so
   * SDKs read policy directly from the response without a side-fetch or a
   * client-side cache. Strategies for fields not listed in `fields` fall back
   * to `default`, which itself defaults to `last_writer_wins` when absent.
   */
  merge_policy: MergePolicy;
}

// ---------------------------------------------------------------------------
// Property sub-types
// ---------------------------------------------------------------------------

/** A binary attachment reference within item properties. */
export interface Attachment {
  blob_ref: string;
  mime_type: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// OAuth types
// ---------------------------------------------------------------------------

/** OAuth token type discriminator. */
export type OAuthTokenType = "access" | "refresh";

/** A registered OAuth application. */
export interface OAuthClient {
  id: string;
  name: string;
  redirect_uris: string[];
  created_at: string;
}

/** Input for registering an OAuth client. */
export interface CreateOAuthClientInput {
  name: string;
  redirect_uris: string[];
}

/** A user's approval for a client — records which scopes were granted. */
export interface OAuthGrant {
  id: string;
  client_id: string;
  scopes: string[];
  created_at: string;
}

/** An OAuth access or refresh token record (without raw token value). */
export interface OAuthToken {
  id: string;
  grant_id: string;
  token_type: OAuthTokenType;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** A short-lived authorization code issued during the consent flow. */
export interface OAuthCode {
  id: string;
  grant_id: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Webhook types
// ---------------------------------------------------------------------------

/** A registered outbound webhook. */
export interface Webhook {
  id: string;
  tenant_id?: string;
  url: string;
  secret: string;
  events: string[];
  type_filter?: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Input for registering a webhook. */
export interface CreateWebhookInput {
  url: string;
  events: string[];
  type_filter?: string;
  secret?: string;
}

/** Input for updating a webhook. */
export interface UpdateWebhookInput {
  url?: string;
  events?: string[];
  type_filter?: string | null;
  active?: boolean;
}

/** A single webhook delivery attempt. */
export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  status_code: number | null;
  attempt: number;
  success: boolean;
  error: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// User model (hosted mode only)
// ---------------------------------------------------------------------------

/** A tenant represents an isolated data namespace. */
export interface Tenant {
  id: string;
  name: string | null;
  created_at: string;
}

/** Per-type feed retention override (days before feed-tier items expire). */
export interface TenantRetentionOverride {
  feed_days: number;
}

/** Tenant-level configuration. Admin-writable via `/tenants/current/config`. */
export interface TenantConfig {
  retention?: Record<string, TenantRetentionOverride>;
}

/** A user account (hosted mode). Owns exactly one tenant. */
export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  provider: string;
  provider_id: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}
