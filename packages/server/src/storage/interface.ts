import type {
  Item,
  CreateItemInput,
  UpdateItemInput,
  Metadata,
  Version,
  Thread,
  ApiKey,
  CreateKeyInput,
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
} from "@myme/shared";
import type { TypeSchema } from "@myme/shared";
import { MymeError, ErrorCode } from "@myme/shared";

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
  parent_id?: string;
  thread_id?: string;
  root_only?: boolean;
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
}

export interface MetadataStore {
  get(itemId: string): Promise<Metadata>;
  getMany(itemIds: string[]): Promise<Metadata[]>;
  set(itemId: string, tags: string[], about: string[]): Promise<Metadata>;
  merge(itemId: string, tags?: string[], about?: string[]): Promise<Metadata>;
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
}

export interface ThreadStore {
  create(tenantId?: string): Promise<Thread>;
  get(id: string, tenantId?: string): Promise<Thread | null>;
  list(
    limit: number,
    cursor?: string,
    tenantId?: string,
  ): Promise<PaginatedResult<Thread>>;
  touch(id: string): Promise<void>;
  getItems(threadId: string, tenantId?: string): Promise<Item[]>;
}

export interface TypeStore {
  list(): Promise<TypeSchema[]>;
  get(id: string): Promise<TypeSchema | undefined>;
  create(schema: TypeSchema, tenantId?: string): Promise<TypeSchema>;
  update(id: string, schema: TypeSchema): Promise<TypeSchema>;
  delete(id: string): Promise<void>;
  loadCustomTypes(): Promise<TypeSchema[]>;
}

export interface SearchStore {
  search(query: string, filters: SearchFilters): Promise<SearchResult[]>;
  index(itemId: string, properties: Record<string, unknown>): Promise<void>;
  remove(itemId: string): Promise<void>;
}

export interface KeyStore {
  create(
    input: CreateKeyInput,
    keyHash: string,
    tenantId?: string,
  ): Promise<ApiKey>;
  list(): Promise<ApiKey[]>;
  validate(
    keyHash: string,
  ): Promise<(ApiKey & { key_hash: string; revoked_at: string | null }) | null>;
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
}

export interface WebhookStore {
  create(input: CreateWebhookInput, tenantId?: string): Promise<Webhook>;
  list(tenantId?: string): Promise<Webhook[]>;
  get(id: string, tenantId?: string): Promise<Webhook | null>;
  update(id: string, input: UpdateWebhookInput): Promise<Webhook>;
  delete(id: string): Promise<void>;
  listActive(): Promise<Webhook[]>;
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
}

// ---------------------------------------------------------------------------
// OAuth store
// ---------------------------------------------------------------------------

export interface OAuthStore {
  createClient(input: {
    name: string;
    redirect_uris: string[];
  }): Promise<import("@myme/shared").OAuthClient>;
  getClient(id: string): Promise<import("@myme/shared").OAuthClient | null>;
  listClients(): Promise<import("@myme/shared").OAuthClient[]>;

  createGrant(
    clientId: string,
    scopes: string[],
  ): Promise<import("@myme/shared").OAuthGrant>;
  getGrantsByClient(
    clientId: string,
  ): Promise<import("@myme/shared").OAuthGrant[]>;

  createCode(
    grantId: string,
    codeHash: string,
    challenge: string,
    method: string,
    redirectUri: string,
    expiresAt: string,
  ): Promise<import("@myme/shared").OAuthCode>;
  /** Atomically marks a code as used. Returns null if already consumed or expired. */
  consumeCode(
    codeHash: string,
  ): Promise<
    (import("@myme/shared").OAuthCode & { scopes: string[] }) | null
  >;

  createToken(
    grantId: string,
    tokenHash: string,
    type: import("@myme/shared").OAuthTokenType,
    expiresAt: string,
  ): Promise<import("@myme/shared").OAuthToken>;
  /** Validates a token hash. Returns null if not found, expired, or revoked. */
  validateToken(
    tokenHash: string,
  ): Promise<
    (import("@myme/shared").OAuthToken & { scopes: string[] }) | null
  >;
  listTokens(): Promise<import("@myme/shared").OAuthToken[]>;
  revokeToken(id: string): Promise<void>;
  reduceTokenScope(id: string, scopes: string[]): Promise<void>;

  /** Marks a refresh token as used. Returns false if already used (replay). */
  markRefreshUsed(id: string): Promise<boolean>;
  /** Revokes all tokens for a grant (used after replay detection). */
  revokeGrantTokens(grantId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Aggregate storage interface
// ---------------------------------------------------------------------------

export interface Storage {
  items: ItemStore;
  metadata: MetadataStore;
  versions: VersionStore;
  threads: ThreadStore;
  types: TypeStore;
  search: SearchStore;
  keys: KeyStore;
  blobs: BlobStore;
  oauth: OAuthStore;
  webhooks: WebhookStore;
  webhookDeliveries: WebhookDeliveryStore;
  users?: UserStore;
  tenants?: TenantStore;
  runInTransaction<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
