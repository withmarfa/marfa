import type {
  Item,
  CreateItemInput,
  UpdateItemInput,
  Metadata,
  Version,
  ApiKey,
  CreateKeyInput,
  UpdateKeyInput,
  Webhook,
  WebhookDelivery,
  CreateWebhookInput,
  UpdateWebhookInput,
  PaginatedResult,
  SearchResult,
  ConflictResponse,
  ItemState,
  User,
  Tenant,
  Edge,
  CreateEdgeInput,
} from "@mymehq/shared";
import type { EdgeTypeSchema, TypeSchema } from "@mymehq/shared";
import { MymeError, ErrorCode } from "@mymehq/shared";

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

export type ItemSortField = "created_at" | "updated_at" | "timestamp";
export type SortDirection = "asc" | "desc";

export interface ItemFilters {
  tenantId?: string;
  type?: string;
  state?: ItemState;
  source?: string;
  /** Restrict to library items (true) or ambient items (false). */
  library?: boolean;
  tags?: string[];
  filter?: string;
  allowed_types?: string[];
  sort?: ItemSortField;
  direction?: SortDirection;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchFilters {
  tenantId?: string;
  type?: string;
  state?: ItemState;
  /** Tri-value library filter, matching `/items`. `true` = library only,
   *  `false` = ambient only, `undefined` = no filter (default). */
  library?: boolean;
  filter?: string;
  allowed_types?: string[];
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Cursor utilities (keyset pagination)
// ---------------------------------------------------------------------------

interface CursorPayload {
  v: string;
  id: string;
}

export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: sortValue, id })).toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as CursorPayload;
    if (typeof parsed.v !== "string" || typeof parsed.id !== "string") {
      throw new Error("Invalid cursor shape");
    }
    return parsed;
  } catch {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid pagination cursor",
    );
  }
}

// ---------------------------------------------------------------------------
// Sub-store interfaces
// ---------------------------------------------------------------------------

export interface ItemStore {
  create(input: CreateItemInput, tenantId?: string): Promise<Item>;
  get(id: string, tenantId?: string): Promise<Item | null>;
  list(filters: ItemFilters): Promise<PaginatedResult<Item>>;
  update(
    id: string,
    input: UpdateItemInput,
    tenantId?: string,
  ): Promise<Item | ConflictResponse>;
  delete(id: string, tenantId?: string): Promise<void>;
  purge(id: string, tenantId?: string): Promise<void>;
  restore(id: string, tenantId?: string): Promise<Item>;
  transition(id: string, state: ItemState, tenantId?: string): Promise<Item>;
  stats(
    tenantId?: string,
    allowedTypes?: string[],
  ): Promise<Record<string, number>>;
  /** Hard-delete every trashed item whose `updated_at` is strictly older
   *  than `beforeDate` (an ISO 8601 timestamp). Cleans the search index
   *  for each row. Returns the number of rows deleted. */
  purgeTrashedOlderThan(beforeDate: string, tenantId?: string): Promise<number>;
  /** Hard-delete every ambient (`library: false`) item whose `updated_at`
   *  is strictly older than `beforeDate`, regardless of state. Cleans the
   *  search index for each row. Returns the number of rows deleted. */
  expireAmbientOlderThan(
    beforeDate: string,
    tenantId?: string,
  ): Promise<number>;
}

export interface MetadataStore {
  get(itemId: string): Promise<Metadata>;
  getMany(itemIds: string[]): Promise<Metadata[]>;
  set(itemId: string, tags: string[]): Promise<Metadata>;
  merge(itemId: string, tags?: string[]): Promise<Metadata>;
  addTags(itemId: string, tags: string[]): Promise<Metadata>;
  removeTag(itemId: string, tag: string): Promise<Metadata>;
  getExtensions(
    itemId: string,
  ): Promise<Record<string, Record<string, unknown>>>;
  setExtension(
    itemId: string,
    namespace: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, Record<string, unknown>>>;
  deleteExtension(
    itemId: string,
    namespace: string,
  ): Promise<Record<string, Record<string, unknown>>>;
}

export interface VersionStore {
  create(
    itemId: string,
    version: number,
    properties: Record<string, unknown>,
    deviceId?: string,
  ): Promise<Version>;
  list(itemId: string): Promise<Version[]>;
  getByVersion(itemId: string, version: number): Promise<Version | null>;
  getLatestTimestamp(itemId: string): Promise<string | null>;
  deleteByIds(ids: string[]): Promise<number>;
  listThinningCandidates(
    threshold: number,
    limit: number,
  ): Promise<{ itemId: string; type: string; versionCount: number }[]>;
}

export interface TypeStore {
  list(): Promise<TypeSchema[]>;
  get(id: string): Promise<TypeSchema | undefined>;
  create(schema: TypeSchema, tenantId?: string): Promise<TypeSchema>;
  update(id: string, schema: TypeSchema): Promise<TypeSchema>;
  delete(id: string): Promise<void>;
  loadCustomTypes(): Promise<TypeSchema[]>;
  countCustom(): Promise<number>;
}

export interface EdgeTypeStore {
  list(): Promise<EdgeTypeSchema[]>;
  get(id: string): Promise<EdgeTypeSchema | undefined>;
  create(schema: EdgeTypeSchema, tenantId?: string): Promise<EdgeTypeSchema>;
  delete(id: string): Promise<void>;
  /** Load every custom edge type for server-startup registry warmup. */
  loadCustomEdgeTypes(): Promise<EdgeTypeSchema[]>;
}

export interface SearchStore {
  search(query: string, filters: SearchFilters): Promise<SearchResult[]>;
  index(
    itemId: string,
    properties: Record<string, unknown>,
    typeId?: string,
  ): Promise<void>;
  remove(itemId: string): Promise<void>;
}

export interface KeyStore {
  create(
    input: CreateKeyInput,
    keyHash: string,
    tenantId?: string,
  ): Promise<ApiKey>;
  list(): Promise<ApiKey[]>;
  get(id: string): Promise<ApiKey | null>;
  validate(
    keyHash: string,
  ): Promise<(ApiKey & { key_hash: string; revoked_at: string | null }) | null>;
  update(id: string, input: UpdateKeyInput): Promise<ApiKey>;
  revoke(id: string): Promise<void>;
  updateLastUsed(id: string): Promise<void>;
  count(): Promise<number>;
}

export interface BlobStore {
  register(
    hash: string,
    mimeType: string,
    size: number,
    storagePath: string,
  ): Promise<void>;
  get(
    hash: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null>;
  listAll(): Promise<string[]>;
  remove(hash: string): Promise<void>;
  count(): Promise<{ count: number; total_size: number }>;
}

export interface WebhookStore {
  create(input: CreateWebhookInput, tenantId?: string): Promise<Webhook>;
  list(tenantId?: string): Promise<Webhook[]>;
  get(id: string, tenantId?: string): Promise<Webhook | null>;
  update(id: string, input: UpdateWebhookInput): Promise<Webhook>;
  delete(id: string): Promise<void>;
  listActive(): Promise<Webhook[]>;
  count(): Promise<number>;
}

export interface WebhookDeliveryStore {
  log(entry: {
    webhookId: string;
    event: string;
    statusCode?: number;
    attempt: number;
    success: boolean;
    error?: string;
  }): Promise<void>;
  list(webhookId: string, limit?: number): Promise<WebhookDelivery[]>;
  schedule(entry: {
    webhookId: string;
    event: string;
    payload: string;
    webhookUrl: string;
    webhookSecret: string;
    nextAttemptAt: string;
  }): Promise<string>;
  getPending(
    now: string,
    limit?: number,
  ): Promise<
    {
      id: string;
      webhook_id: string;
      event: string;
      payload: string;
      webhook_url: string;
      webhook_secret: string;
      attempt: number;
      max_attempts: number;
    }[]
  >;
  markSuccess(id: string, statusCode: number, attempt: number): Promise<void>;
  markFailed(
    id: string,
    statusCode: number | undefined,
    error: string,
    attempt: number,
    nextAttemptAt: string | null,
  ): Promise<void>;
  markDeadLetter(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// User + Tenant stores (hosted mode only)
// ---------------------------------------------------------------------------

export interface UserStore {
  create(input: {
    email: string;
    name?: string;
    avatar_url?: string;
    provider: string;
    provider_id: string;
    tenant_id: string;
  }): Promise<User>;
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  getByProvider(provider: string, providerId: string): Promise<User | null>;
  getByTenantId(tenantId: string): Promise<User | null>;
}

export interface TenantStore {
  create(name?: string): Promise<Tenant>;
  get(id: string): Promise<Tenant | null>;
  getConfig(id: string): Promise<import("@mymehq/shared").TenantConfig | null>;
  updateConfig(
    id: string,
    config: import("@mymehq/shared").TenantConfig,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// OAuth store
// ---------------------------------------------------------------------------

export interface OAuthStore {
  createClient(input: {
    name: string;
    redirect_uris: string[];
  }): Promise<import("@mymehq/shared").OAuthClient>;
  getClient(id: string): Promise<import("@mymehq/shared").OAuthClient | null>;
  listClients(): Promise<import("@mymehq/shared").OAuthClient[]>;

  createGrant(
    clientId: string,
    scopes: string[],
  ): Promise<import("@mymehq/shared").OAuthGrant>;
  getGrantsByClient(
    clientId: string,
  ): Promise<import("@mymehq/shared").OAuthGrant[]>;

  createCode(
    grantId: string,
    codeHash: string,
    challenge: string,
    method: string,
    redirectUri: string,
    expiresAt: string,
  ): Promise<import("@mymehq/shared").OAuthCode>;
  /** Atomically marks a code as used. Returns null if already consumed or expired. */
  consumeCode(
    codeHash: string,
  ): Promise<
    (import("@mymehq/shared").OAuthCode & { scopes: string[] }) | null
  >;

  createToken(
    grantId: string,
    tokenHash: string,
    type: import("@mymehq/shared").OAuthTokenType,
    expiresAt: string,
  ): Promise<import("@mymehq/shared").OAuthToken>;
  /** Validates a token hash. Returns null if not found, expired, or revoked. */
  validateToken(
    tokenHash: string,
  ): Promise<
    (import("@mymehq/shared").OAuthToken & { scopes: string[] }) | null
  >;
  listTokens(): Promise<import("@mymehq/shared").OAuthToken[]>;
  revokeToken(id: string): Promise<void>;
  reduceTokenScope(id: string, scopes: string[]): Promise<void>;

  /** Marks a refresh token as used. Returns false if already used (replay). */
  markRefreshUsed(id: string): Promise<boolean>;
  /** Revokes all tokens for a grant (used after replay detection). */
  revokeGrantTokens(grantId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Audit store
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  timestamp: string;
  key_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown>;
}

export interface AuditStore {
  log(entry: {
    key_id?: string;
    action: string;
    resource_type: string;
    resource_id?: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  list(filters: {
    action?: string;
    resource_type?: string;
    resource_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResult<AuditEntry>>;
  cleanup(retentionDays: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Event log store (SSE event persistence for replay)
// ---------------------------------------------------------------------------

export interface PersistedEvent {
  id: number;
  event_type: string;
  /** Populated on item events; null on edge events. Migration 0014
   *  relaxed this to nullable so edge events no longer reuse source_id
   *  as a NOT NULL workaround. */
  item_id: string | null;
  edge_id: string | null;
  tenant_id: string | null;
  payload: string;
  created_at: string;
}

export interface EventLogStore {
  /** Append an event and return its assigned sequential ID. */
  append(entry: {
    event_type: string;
    /** Non-null for item events; null for edge events. */
    item_id?: string | null;
    /** Non-null for edge events; lets subscribers filter Last-Event-ID
     *  replay by a specific edge in addition to by item. */
    edge_id?: string | null;
    tenant_id?: string;
    payload: string;
  }): Promise<number>;

  /** Retrieve events after a given ID, optionally filtered by tenant. */
  getAfter(
    afterId: number,
    limit: number,
    tenantId?: string,
  ): Promise<PersistedEvent[]>;

  /** Delete events older than the given retention period. Returns count deleted. */
  cleanup(retentionHours: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Aggregate storage interface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edge store
// ---------------------------------------------------------------------------

export interface EdgeListFilters {
  edge_type?: string | string[];
  limit?: number;
  cursor?: string;
}

export interface EdgeStore {
  /** Create an edge. Constraint enforcement (cardinality / cycles / type) sits outside. */
  createRaw(input: CreateEdgeInput, tenantId?: string): Promise<Edge>;
  get(id: string): Promise<Edge | null>;
  /** Outbound edges — this item is the source. */
  listFromSource(
    sourceId: string,
    filters?: EdgeListFilters,
  ): Promise<PaginatedResult<Edge>>;
  /** Inbound edges — this item is the target. */
  listToTarget(
    targetId: string,
    filters?: EdgeListFilters,
  ): Promise<PaginatedResult<Edge>>;
  updateProperties(
    id: string,
    properties: Record<string, unknown>,
  ): Promise<Edge>;
  delete(id: string): Promise<void>;
  deleteBySource(sourceId: string, edgeType?: string): Promise<void>;
  deleteByTarget(targetId: string, edgeType?: string): Promise<void>;
  /** Count edges where the given item is source. Used for cardinality checks. */
  countBySource(sourceId: string, edgeType: string): Promise<number>;
  /** Count edges where the given item is target. Used for cardinality checks. */
  countByTarget(targetId: string, edgeType: string): Promise<number>;
  /** Exact-duplicate check (source_id, target_id, edge_type). */
  existsExact(
    sourceId: string,
    targetId: string,
    edgeType: string,
  ): Promise<boolean>;
  /**
   * All outbound edges of a given type from sourceId. Used for cycle checks,
   * cascade-on-delete, and edge hydration when the caller wants every entry.
   */
  listOutboundOfType(sourceId: string, edgeType: string): Promise<Edge[]>;
  /**
   * All edges touching the given item — outbound (item is source) and inbound
   * (item is target). Used by cascade-on-delete to gather the full edge set
   * around an item being deleted.
   */
  listAllByItem(itemId: string): Promise<{ outbound: Edge[]; inbound: Edge[] }>;
  /** Batched outbound-by-types fetch for hydration on item reads. */
  listFromSourcesBatched(
    sourceIds: string[],
    perTypeLimit: number,
  ): Promise<Map<string, Edge[]>>;
}

export interface Storage {
  items: ItemStore;
  metadata: MetadataStore;
  versions: VersionStore;
  types: TypeStore;
  search: SearchStore;
  keys: KeyStore;
  blobs: BlobStore;
  edges: EdgeStore;
  edgeTypes: EdgeTypeStore;
  oauth: OAuthStore;
  webhooks: WebhookStore;
  webhookDeliveries: WebhookDeliveryStore;
  audit: AuditStore;
  eventLog: EventLogStore;
  users?: UserStore;
  tenants?: TenantStore;
  runInTransaction<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
