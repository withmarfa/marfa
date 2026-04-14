// Myme types — the wire format for the Myme API.
// These interfaces define what goes over the network between server and clients.

import type { ItemState } from "@mymehq/types";

/** Valid item states as a readonly array, useful for validation. */
export const ITEM_STATES: readonly ItemState[] = [
  "active",
  "archived",
  "trashed",
] as const;

/** Authorship class of an item's content. */
export type Origin = "user" | "ai" | "worker";

/** Valid origin values as a readonly array, useful for validation. */
export const ORIGINS: readonly Origin[] = ["user", "ai", "worker"] as const;

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
  /** Whether this item is part of the curated personal-data layer. */
  library: boolean;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  timestamp: string;
  source?: string;
  source_id?: string;
  origin?: Origin;
  version: number;
  schema_version: number;
  device?: string;
  parent_id: string | null;
  thread_id: string | null;
  capture_latitude?: number;
  capture_longitude?: number;
}

/** Input for creating a new item. */
export interface CreateItemInput {
  type: string;
  properties: Record<string, unknown>;
  id?: string;
  state?: ItemState;
  /** Overrides the credential's default_library when supplied. */
  library?: boolean;
  timestamp?: string;
  /** Ignored on the wire — server always stamps source from the credential. */
  source?: string;
  source_id?: string;
  origin?: Origin;
  device?: string;
  parent_id?: string;
  thread_id?: string;
  capture_latitude?: number;
  capture_longitude?: number;
  tags?: string[];
  about?: string[];
}

/** Input for updating an existing item. */
export interface UpdateItemInput {
  properties?: Record<string, unknown>;
  parent_id?: string | null;
  thread_id?: string | null;
  version?: number;
  snapshot?: boolean;
}

/** An item paired with its metadata sidecar. */
export interface ItemWithMetadata {
  item: Item;
  metadata: Metadata;
}

/** Metadata sidecar — tags, entity references, and namespaced extensions. */
export interface Metadata {
  item_id: string;
  tags: string[];
  about: string[];
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

/** A sequential grouping of items. */
export interface Thread {
  id: string;
  created_at: string;
  updated_at: string;
}

/** An API key record (without the key value itself). */
export interface ApiKey {
  id: string;
  tenant_id?: string;
  label: string;
  /** Human-readable display name stamped onto items this credential writes. */
  source: string;
  role: KeyRole;
  /** Origin stamped onto items when the client doesn't supply one. */
  default_origin: Origin;
  /** Library flag stamped onto items when the client doesn't supply one. */
  default_library: boolean;
  type_permissions: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  created_at: string;
  last_used_at: string | null;
}

/** Input for creating a new API key. */
export interface CreateKeyInput {
  label: string;
  source: string;
  role: KeyRole;
  default_origin?: Origin;
  default_library?: boolean;
  type_permissions?: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
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

/** Per-type ambient retention override (days before ambient items expire). */
export interface TenantRetentionOverride {
  ambient_days: number;
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
