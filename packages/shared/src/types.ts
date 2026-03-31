// Protocol types — the wire format for the Myme API.
// These interfaces define what goes over the network between server and clients.

/** Lifecycle states for items. */
export type ItemState = "new" | "active" | "archived" | "trashed";

/** Valid item states as a readonly array, useful for validation. */
export const ITEM_STATES: readonly ItemState[] = [
  "new",
  "active",
  "archived",
  "trashed",
] as const;

/** API key roles. */
export type KeyRole = "admin" | "member";

/** Per-type permission levels. */
export type TypePermission = "read" | "write" | "none";

// ---------------------------------------------------------------------------
// Core protocol types
// ---------------------------------------------------------------------------

/** A Myme item — the fundamental data record. */
export interface Item {
  id: string;
  type: string;
  state: ItemState;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  timestamp: string;
  source?: string;
  source_id?: string;
  origin?: string;
  version: number;
  schema_version?: number;
  device_id?: string;
  parent_id?: string;
  thread_id?: string;
  capture_latitude?: number;
  capture_longitude?: number;
}

/** Input for creating a new item. */
export interface CreateItemInput {
  type: string;
  properties: Record<string, unknown>;
  id?: string;
  state?: ItemState;
  timestamp?: string;
  source?: string;
  source_id?: string;
  origin?: string;
  device_id?: string;
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
  version: number;
}

/** Metadata sidecar — tags and entity references, stored separately from properties. */
export interface Metadata {
  item_id: string;
  tags: string[];
  about: string[];
}

/** A frozen snapshot of an item's previous state. */
export interface Version {
  id: string;
  item_id: string;
  version: number;
  properties: Record<string, unknown>;
  created_at: string;
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
  label: string;
  role: KeyRole;
  type_permissions: Record<string, TypePermission>;
  created_at: string;
}

/** Input for creating a new API key. */
export interface CreateKeyInput {
  label: string;
  role: KeyRole;
  type_permissions?: Record<string, TypePermission>;
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
