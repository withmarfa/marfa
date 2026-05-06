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
  InboundWebhookEvent,
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
  /** Multi-source filter (TSC42 §5 source-filter lever). When set, results
   *  are narrowed to items whose `source` is in the array. `source` and
   *  `sources` may both be set; the single-source filter is AND'd with the
   *  multi-source filter. */
  sources?: string[];
  /** Restrict to a specific tier. Omit for the default unfiltered scope. */
  tier?: "library" | "feed";
  /** When true, items whose type starts with `system.` are excluded from
   *  the result set. The route layer flips this on by default; callers
   *  opt back in by listing `?include=system` or filtering on a specific
   *  `system.*` type. */
  exclude_system_types?: boolean;
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
  /** Tier filter, matching `/items`. Omit for unfiltered. */
  tier?: "library" | "feed";
  /** Multi-source filter (TSC42 §5 source-filter lever). */
  sources?: string[];
  /** Mirrors `ItemFilters.exclude_system_types`. */
  exclude_system_types?: boolean;
  /** Items must have ALL specified tags. Mirrors `/items?tags=` semantics. */
  tags?: string[];
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
  /**
   * Batched `get` — returns a map keyed by item id for every id in `ids` that
   * resolves to a non-trashed item in the caller's tenant scope. Missing ids
   * are simply absent from the map; no errors. Used by the edge-validation
   * batcher to collapse per-pair item fetches into a single IN query.
   */
  getMany(ids: string[], tenantId?: string): Promise<Map<string, Item>>;
  /**
   * Like `get`, but returns trashed items too. Intended for callers that
   * need to read an item's metadata (e.g. its `type` for a permission
   * check) even when the item has been soft-deleted — the edge
   * PATCH/DELETE permission check is the canonical caller. Trashed
   * items are not returned by `get`/`list`, and do not leak to this
   * method via `restore` either; use the normal `restore()` to
   * un-trash.
   */
  getIncludingTrashed(id: string, tenantId?: string): Promise<Item | null>;
  list(filters: ItemFilters): Promise<PaginatedResult<Item>>;
  /**
   * Look up a single non-trashed item by `(source, source_id)` within a
   * tenant. Returns null if no row matches. Used by `/items/bulk` upsert
   * to decide create-vs-update without round-tripping a full `list`.
   */
  findBySourceId(
    source: string,
    sourceId: string,
    tenantId?: string,
  ): Promise<Item | null>;
  update(
    id: string,
    input: UpdateItemInput,
    tenantId?: string,
  ): Promise<Item | ConflictResponse>;
  delete(id: string, tenantId?: string): Promise<void>;
  purge(id: string, tenantId?: string): Promise<void>;
  /**
   * Hard-delete every id in `ids` within the tenant scope. Bypasses the
   * "must be trashed" gate that single-item `purge` enforces — bulk is an
   * admin cleanup primitive with explicit confirm. Cascades metadata and
   * versions via ON DELETE CASCADE; caller must have already wiped edges
   * (source + target directions). Cleans the search index for each id.
   * Returns the number of rows actually deleted (rows not in tenant are
   * silently skipped).
   */
  bulkPurge(ids: string[], tenantId?: string): Promise<number>;
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
  /** Hard-delete every feed-tier item whose `updated_at` is strictly older
   *  than `beforeDate`, regardless of state. Cleans the search index for
   *  each row. Returns the number of rows deleted. */
  expireFeedOlderThan(beforeDate: string, tenantId?: string): Promise<number>;
}

export interface MetadataStore {
  get(itemId: string): Promise<Metadata>;
  getMany(itemIds: string[]): Promise<Metadata[]>;
  set(itemId: string, tags: string[]): Promise<Metadata>;
  merge(itemId: string, tags?: string[]): Promise<Metadata>;
  addTags(itemId: string, tags: string[]): Promise<Metadata>;
  removeTag(itemId: string, tag: string): Promise<Metadata>;
  /**
   * Enumerate the distinct set of tags in use across items visible to the
   * caller. Tenant-scoped; type-permission scoped when `allowedTypes` is
   * provided (same pattern as `ItemStore.list`). Trashed items are excluded.
   * Returns tags with their usage counts, sorted by count descending.
   */
  listTags(filters: {
    tenantId?: string;
    allowedTypes?: string[];
  }): Promise<{ tag: string; count: number }[]>;
  getExtensions(
    itemId: string,
  ): Promise<Record<string, Record<string, unknown>>>;
  /**
   * Batched read of extensions across many items in a single query. Used
   * by the list-hydration path (`GET /items?include=extensions`) to
   * avoid the N+1 pattern where a caller would otherwise hit
   * `GET /items/:id/extensions` once per listed item. The map's keys are
   * item ids; items with no persisted metadata row map to an empty
   * record.
   */
  getExtensionsForItems(
    itemIds: string[],
  ): Promise<Map<string, Record<string, Record<string, unknown>>>>;
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
  /**
   * Mint a runtime credential. Distinct from `create` because runtime
   * credentials carry the load-bearing `is_runtime_credential` and
   * `connection_id` stamps that the extension gate keys off of —
   * neither field is settable through `CreateKeyInput`. Only the
   * `POST /system/runtime-credentials` route calls this; that route is
   * itself gated on platform credentials.
   */
  createRuntimeCredential(
    input: CreateKeyInput & { connection_id: string },
    keyHash: string,
    tenantId?: string,
  ): Promise<ApiKey>;
  list(): Promise<ApiKey[]>;
  get(id: string): Promise<ApiKey | null>;
  /**
   * Active (non-revoked) keys whose `connection_id` matches. The
   * uninstall pipeline uses this to locate the runtime credential bound
   * to a connection before revoking it. Tenant-scoped when supplied —
   * single-tenant self-hosted deployments pass `undefined` to read keys
   * with no tenant binding. Indexed on the `connection_id` column.
   */
  listByConnectionId(
    connectionId: string,
    tenantId?: string,
  ): Promise<ApiKey[]>;
  validate(
    keyHash: string,
  ): Promise<(ApiKey & { key_hash: string; revoked_at: string | null }) | null>;
  update(id: string, input: UpdateKeyInput): Promise<ApiKey>;
  revoke(id: string): Promise<void>;
  updateLastUsed(id: string): Promise<void>;
  count(): Promise<number>;
}

/**
 * Per-tenant blob metadata store (T-049).
 *
 * **Tenant scoping.** The `blobs` table has a composite PK on
 * `(tenant_id, hash)`; the same hash can appear under multiple tenant_ids
 * (the storage backend dedupes physically — one file per hash — but each
 * tenant gets their own metadata row). The empty string `""` is the
 * sentinel for "instance-wide / single-tenant / platform-admin"; routes
 * pass `key.tenant_id ?? ""` so single-tenant deployments and
 * platform-admin uploads continue to interoperate.
 *
 * `register`, `get`, `remove` all take a tenant scope — passing the wrong
 * tenant returns null / no-op rather than the row from another tenant.
 *
 * `listAll` and `count` are unscoped — they're admin reconciliation
 * helpers (reconcile route + metrics), gated to platform admins at the
 * route layer.
 */
export interface BlobStore {
  register(
    hash: string,
    mimeType: string,
    size: number,
    storagePath: string,
    tenantId: string,
  ): Promise<void>;
  get(
    hash: string,
    tenantId: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null>;
  /**
   * Returns hashes seen across the entire instance (every tenant), de-duplicated.
   * Used only by the admin reconcile route + metrics. Tenant-scoped reads
   * MUST go through `get(hash, tenantId)`.
   */
  listAll(): Promise<string[]>;
  remove(hash: string, tenantId: string): Promise<void>;
  /**
   * Removes every row for a given hash across all tenants. Used only by
   * the admin orphan-cleanup + reconcile routes — the platform admin
   * decided this hash is unreferenced everywhere, so all per-tenant
   * metadata rows go. Tenant-scoped deletes use `remove(hash, tenantId)`.
   */
  removeAllForHash(hash: string): Promise<void>;
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

/**
 * Row shape returned by `getPending` and `claimById` — the subset of the
 * delivery row that the poller / direct-dispatcher needs to make an HTTP
 * attempt and write its outcome.
 */
export interface PendingWebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  webhook_url: string;
  webhook_secret: string;
  attempt: number;
  max_attempts: number;
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
  getPending(now: string, limit?: number): Promise<PendingWebhookDelivery[]>;
  /**
   * Atomic single-row claim for best-effort direct dispatch. Succeeds only
   * when the row is still `status = 'pending'` and still past its
   * `next_attempt_at` — otherwise returns `null`. On success, the row's
   * `next_attempt_at` is pushed forward to `claimExpiry` so the poller's
   * next tick doesn't see it. Same lock-ttl semantics as `getPending`.
   */
  claimById(
    id: string,
    claimExpiry: string,
    now: string,
  ): Promise<PendingWebhookDelivery | null>;
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
// Inbound webhook subsystem (workstream 2 PR 5)
// ---------------------------------------------------------------------------

/**
 * Row shape returned by the SQL stores. The route layer translates this
 * to the wire `InboundWebhook` (redacting the secret) at response time.
 * `secret_encrypted` is the raw column value — pass it through
 * `decryptSecret` to recover the plaintext.
 */
export interface InboundWebhookRow {
  id: string;
  tenant_id: string | null;
  connection_id: string;
  external_service_id: string | null;
  secret_encrypted: string;
  verification_method: string;
  verification_adapter_id: string | null;
  events: string[];
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Storage for inbound webhook subscriptions. The store is intentionally
 * narrow — manifest validation and verification dispatch happen at the
 * route layer; this interface just persists rows.
 */
export interface InboundWebhookStore {
  create(input: {
    id: string;
    tenant_id?: string;
    connection_id: string;
    external_service_id?: string;
    secret_encrypted: string;
    verification_method: string;
    verification_adapter_id?: string;
    events: string[];
  }): Promise<InboundWebhookRow>;
  get(id: string, tenantId?: string): Promise<InboundWebhookRow | null>;
  /**
   * `getAny` — looks up a row regardless of tenant scope. Used by the
   * public unauth POST /webhooks/inbound/:id receipt path, which has no
   * caller credential to scope by; tenant isolation is enforced at the
   * subscription / read paths instead.
   */
  getAny(id: string): Promise<InboundWebhookRow | null>;
  listByConnection(
    connectionId: string,
    tenantId?: string,
  ): Promise<InboundWebhookRow[]>;
  setDisabled(id: string, disabled: boolean): Promise<void>;
}

export interface InboundWebhookEventStore {
  /**
   * Insert a receipt row. On a duplicate (inbound_webhook_id,
   * external_delivery_id) pair, the implementation MUST NOT throw —
   * the existing row id is returned with `inserted: false` so the
   * route can distinguish a fresh receipt from a duplicate retry.
   */
  insert(input: {
    id: string;
    inbound_webhook_id: string;
    external_delivery_id: string;
    received_at: string;
    payload: string;
    verified: boolean;
    processing_error?: string;
  }): Promise<{ id: string; inserted: boolean }>;
  list(
    inboundWebhookId: string,
    limit?: number,
  ): Promise<InboundWebhookEvent[]>;
  get(id: string): Promise<InboundWebhookEvent | null>;
  /**
   * Reset a row for manual replay from DLQ. Sets retry_count back to 0,
   * processing_error to null, next_attempt_at to the supplied
   * timestamp — bringing the row back into the pending partial-index
   * window for WS3's reactive runner to pick up.
   */
  resetForRetry(id: string, nextAttemptAt: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Connection OAuth token store (workstream 2 PR 6)
// ---------------------------------------------------------------------------

/**
 * Row shape persisted in `connection_oauth_tokens`. Tokens are stored
 * encrypted under HKDF(MYME_AUTH_SECRET, "connection-oauth-tokens"); the
 * proxy route decrypts at request time. `previous_refresh_hash` is the
 * SHA-256 (hex) of the most recent rotated-out refresh token, kept for
 * forensic logging — active replay enforcement is the upstream's
 * `invalid_grant` response.
 */
export interface ConnectionOAuthTokenRow {
  id: string;
  connection_id: string;
  tenant_id: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string;
  scopes: string[];
  previous_refresh_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionOAuthTokenStore {
  /**
   * Upsert the token for a connection. Existing rows for the same
   * connection_id are overwritten in place — the table is unique on
   * connection_id so re-authorisation collapses to a single row.
   */
  upsert(input: {
    connection_id: string;
    tenant_id?: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
    expires_at: string;
    scopes: string[];
    /** SHA-256 hex of the rotated-out refresh token; null on initial save. */
    previous_refresh_hash?: string | null;
  }): Promise<ConnectionOAuthTokenRow>;

  /** Lookup by connection_id. Tenant-scoped when supplied. */
  get(
    connectionId: string,
    tenantId?: string,
  ): Promise<ConnectionOAuthTokenRow | null>;

  /** Hard-delete the row for a connection (used on revocation). */
  delete(connectionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Connection leased token store (workstream 2 PR 7)
// ---------------------------------------------------------------------------

/**
 * Row shape persisted in `connection_leased_tokens`. The lease IS a
 * bearer token; storage is hashed (SHA-256) like API keys, plaintext
 * is returned ONCE on issue. Capability gating ties each lease to a
 * manifest-declared `oauth_requirements: { <capability_id>: "leased" }`
 * entry.
 */
export interface ConnectionLeasedTokenRow {
  id: string;
  connection_id: string;
  tenant_id: string | null;
  capability_id: string;
  lease_token_hash: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  issued_by_key_id: string | null;
  created_at: string;
}

export interface ConnectionLeasedTokenStore {
  create(input: {
    id: string;
    connection_id: string;
    tenant_id?: string;
    capability_id: string;
    lease_token_hash: string;
    scopes: string[];
    expires_at: string;
    issued_by_key_id?: string;
  }): Promise<ConnectionLeasedTokenRow>;

  /** Hash-keyed lookup — used by the validate endpoint. */
  findByHash(hash: string): Promise<ConnectionLeasedTokenRow | null>;

  /** Id-keyed lookup — used by the revoke endpoint. */
  get(id: string, tenantId?: string): Promise<ConnectionLeasedTokenRow | null>;

  /** List active (non-revoked, non-expired) leases for a connection. */
  listActiveByConnection(
    connectionId: string,
    nowIso: string,
    tenantId?: string,
  ): Promise<ConnectionLeasedTokenRow[]>;

  /** Stamp `revoked_at`. Returns false when the lease was already revoked. */
  revoke(id: string, nowIso: string): Promise<boolean>;
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
  /** Lookup by claimed handle (TSC42 §8). Used for collision detection. */
  getByHandle(handle: string): Promise<User | null>;
  /** Claim or change a user's handle. Throws on collision. */
  setHandle(id: string, handle: string): Promise<User>;
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

/**
 * Per-tenant quota store (T-052). Stores ceilings; counts are computed
 * on-demand from existing tables at quota-check time.
 */
export interface TenantQuotaStore {
  /** Returns the per-tenant ceilings; null when no row exists (use env defaults). */
  get(tenantId: string): Promise<import("@mymehq/shared").TenantQuota | null>;
  /** Upserts ceilings. Pass null on a field to clear it (revert to env default). */
  set(
    tenantId: string,
    input: {
      items_limit?: number | null;
      webhooks_limit?: number | null;
      blobs_limit?: number | null;
      storage_bytes_limit?: number | null;
      rate_per_minute_limit?: number | null;
    },
  ): Promise<import("@mymehq/shared").TenantQuota>;
  /** Returns the current count for a resource within a tenant. */
  count(
    tenantId: string,
    resource: import("@mymehq/shared").QuotaResource,
  ): Promise<number>;
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

  createCode(
    connectionItemId: string,
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
    connectionItemId: string,
    tokenHash: string,
    type: import("@mymehq/shared").OAuthTokenType,
    expiresAt: string,
  ): Promise<import("@mymehq/shared").OAuthToken>;
  /** Validates a token hash. Returns null if not found, expired, or revoked.
   *  `tenant_id` is read off the underlying `system.connection` user-app-grant
   *  item; null when the grant predates tenant scoping (single-tenant). */
  validateToken(tokenHash: string): Promise<
    | (import("@mymehq/shared").OAuthToken & {
        scopes: string[];
        tenant_id: string | null;
      })
    | null
  >;
  listTokens(): Promise<import("@mymehq/shared").OAuthToken[]>;
  revokeToken(id: string): Promise<void>;
  reduceTokenScope(id: string, scopes: string[]): Promise<void>;

  /** Marks a refresh token as used. Returns false if already used (replay). */
  markRefreshUsed(id: string): Promise<boolean>;
  /** Revokes all tokens for a grant (used after replay detection). */
  revokeGrantTokens(connectionItemId: string): Promise<void>;

  // ----- Device Authorization Grant (RFC 8628) -----

  /** Insert a new device-code row. Caller hashes `device_code` and supplies
   *  the unique `user_code`; both are stored verbatim. Used by the
   *  initiate endpoint. */
  createDeviceCode(input: {
    deviceCodeHash: string;
    userCode: string;
    clientId: string;
    scope: string;
    expiresAt: string;
    intervalSeconds: number;
  }): Promise<import("@mymehq/shared").OAuthDeviceCode>;

  /** Lookup by SHA-256 of the device_code. Used by the polling endpoint.
   *  Returns null if the row doesn't exist; expired rows are returned
   *  with `status: "pending"` (caller checks `expires_at` to decide). */
  findDeviceCodeByHash(
    hash: string,
  ): Promise<import("@mymehq/shared").OAuthDeviceCode | null>;

  /** Lookup by user_code. Used by the verification page. */
  findDeviceCodeByUserCode(
    userCode: string,
  ): Promise<import("@mymehq/shared").OAuthDeviceCode | null>;

  /** Stamp `last_polled_at`. Used by the polling endpoint to detect
   *  `slow_down` (client polled inside the interval window). */
  markDeviceCodePolled(id: string, now: string): Promise<void>;

  /** Flip status to `approved`, set `connection_item_id` and
   *  `approved_at`. Returns false if the row was not pending. */
  approveDeviceCode(id: string, connectionItemId: string): Promise<boolean>;

  /** Flip status to `denied`. Returns false if the row was not pending. */
  denyDeviceCode(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Audit store
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  timestamp: string;
  key_id: string | null;
  /**
   * Tenant scope (T-041). Stamped at write time from the calling api key's
   * `tenant_id`. Null for system-initiated audits (install pipeline,
   * cycle-budget overflow) and for bootstrap-admin keys that have no tenant.
   * `GET /audit` filters on this column when the caller is tenant-scoped;
   * tenantless callers (bootstrap admin) read every row.
   */
  tenant_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  /**
   * Resolved client IP (T-027). Persisted into `details.client_ip` so no
   * schema migration is needed; surfaced as a typed top-level field on the
   * read path. Null for system-initiated audits (install pipeline,
   * cycle-budget overflow) where no Hono context exists.
   */
  client_ip: string | null;
  details: Record<string, unknown>;
}

export interface AuditStore {
  log(entry: {
    key_id?: string;
    /** See `AuditEntry.tenant_id`. Pass `c.get("apiKey")?.tenant_id ?? null`
     *  from route handlers; null for system-initiated audits and for the
     *  bootstrap-admin shape on self-hosted single-tenant deployments. */
    tenant_id?: string | null;
    action: string;
    resource_type: string;
    resource_id?: string;
    /** See `AuditEntry.client_ip`. Pass `c.var.clientIp ?? null` from
     *  route handlers; null for system-initiated audits. */
    client_ip?: string | null;
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
    /** Tenant-scope filter (T-041). When set, returns only rows whose
     *  `tenant_id` matches. When omitted, every row is returned —
     *  bootstrap-admin reads on a self-hosted deployment, plus the
     *  cleanup job which is currently global. */
    tenant_id?: string | null;
  }): Promise<PaginatedResult<AuditEntry>>;
  cleanup(retentionDays: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Event log store (SSE event persistence for replay)
// ---------------------------------------------------------------------------

export interface PersistedEvent {
  /** i64 event-log id. Carried as `bigint` (not `number`) so values above
   *  Number.MAX_SAFE_INTEGER round-trip without truncation. The SSE wire
   *  serialises via `String(id)` and parses via `BigInt(Last-Event-ID)`. */
  id: bigint;
  event_type: string;
  /** Populated on item events; null on edge events. Migration 0014
   *  relaxed this to nullable so edge events no longer reuse source_id
   *  as a NOT NULL workaround. */
  item_id: string | null;
  edge_id: string | null;
  tenant_id: string | null;
  payload: string;
  /**
   * The connection whose action set off this chain of events. Null for
   * events originating from a human caller. (Workstream 2 PR 8.)
   */
  originating_connection_id: string | null;
  /** Hop number from the originating event. 0 = first event in a chain. */
  hop_count: number;
  created_at: string;
}

export interface EventLogStore {
  /** Append an event and return its assigned sequential ID (i64 bigint). */
  append(entry: {
    event_type: string;
    /** Non-null for item events; null for edge events. */
    item_id?: string | null;
    /** Non-null for edge events; lets subscribers filter Last-Event-ID
     *  replay by a specific edge in addition to by item. */
    edge_id?: string | null;
    tenant_id?: string;
    payload: string;
    /** Cycle-detection metadata (workstream 2 PR 8). */
    originating_connection_id?: string | null;
    hop_count?: number;
  }): Promise<bigint>;

  /** Retrieve events after a given ID, optionally filtered by tenant. */
  getAfter(
    afterId: bigint,
    limit: number,
    tenantId?: string,
  ): Promise<PersistedEvent[]>;

  /** Delete events older than the given retention period. Returns count deleted. */
  cleanup(retentionHours: number): Promise<number>;

  /** Smallest surviving event id, scoped to a tenant when provided.
   *  Returns null when no events match. Used by the SSE route to
   *  detect clients whose `Last-Event-ID` predates the retention
   *  window so it can emit a terminal `catchup_too_old` event
   *  instead of silently resuming mid-stream. */
  getMinRetainedId(tenantId?: string): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------
// Settings store (workspace-wide KV for bootstrap sentinel etc.)
// ---------------------------------------------------------------------------

export interface SettingsStore {
  /** Returns null when the key has not been set. */
  get(key: string): Promise<string | null>;
  /** Upsert — overwrites any existing value for the key. */
  set(key: string, value: string): Promise<void>;
  /** Atomic insert-or-bail: returns true if this caller's INSERT created the
   *  row, false if a row already existed. Used by the bootstrap path so that
   *  exactly one of N concurrent `POST /keys` on a fresh DB wins the right
   *  to mint the seed admin key (T-007). */
  claim(key: string, value: string): Promise<boolean>;
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
  /**
   * Global list of edges across the whole tenant. Used by clients that need
   * "every edge of type X" (thread-root counting, taxonomy traversal, etc.)
   * — replaces the N+1 walk-every-item pattern. Tenant-scoped; trashed-item
   *  filtering is the caller's responsibility (edges to trashed items are
   *  still real edges from a graph perspective).
   */
  list(
    filters?: EdgeListFilters & { tenantId?: string },
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
  /**
   * Batched `countBySource` — for each distinct `(source_id, edge_type)` pair
   * returns the row count. Key format: `${source_id}|${edge_type}`. Pairs
   * absent from the result map have count zero. One SQL query per distinct
   * `edge_type` in `pairs`.
   */
  countsBySourceBatch(
    pairs: { source_id: string; edge_type: string }[],
  ): Promise<Map<string, number>>;
  /**
   * Batched `countByTarget` — mirror of `countsBySourceBatch`, keyed as
   * `${target_id}|${edge_type}`.
   */
  countsByTargetBatch(
    pairs: { target_id: string; edge_type: string }[],
  ): Promise<Map<string, number>>;
  /** Exact-duplicate check (source_id, target_id, edge_type). */
  existsExact(
    sourceId: string,
    targetId: string,
    edgeType: string,
  ): Promise<boolean>;
  /**
   * Batched `existsExact` — returns the subset of triples that already exist.
   * Key format: `${source_id}|${target_id}|${edge_type}`. Callers check
   * membership to decide whether to reject a proposed edge as a duplicate.
   * One SQL query per distinct `edge_type`.
   */
  existsExactBatch(
    pairs: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
  ): Promise<Set<string>>;
  /**
   * Batched triple-to-Edge lookup. For each `(source_id, target_id, edge_type)`
   * that matches an existing row, returns the full `Edge` keyed as
   * `${source_id}|${target_id}|${edge_type}`. Triples with no match are
   * absent. Used by `POST /edges/bulk` upsert to resolve duplicate edges to
   * their ids for in-place property updates. One SQL query per distinct
   * `edge_type`.
   */
  findByTriplesBatch(
    pairs: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
  ): Promise<Map<string, Edge>>;
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

/**
 * Cross-instance coordination primitives. On Postgres, `withJobLock` wraps
 * `pg_try_advisory_lock` so a named background job runs on at most one
 * instance per tick. On SQLite, every backing database is single-process
 * by definition, so the implementation is a pass-through.
 */
export interface CoordinationStore {
  /**
   * Attempt to acquire a named coordination lock, run `fn`, release the
   * lock. Returns `fn`'s result on acquisition, `undefined` when another
   * instance already holds the lock (the caller should treat this as a
   * no-op tick, not an error).
   */
  withJobLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined>;
}

/**
 * Typed handle that storage implementations expose for the better-auth
 * integration (§3.13). The two dialect-specific Drizzle handles diverge
 * structurally; the public Storage contract carries them as `unknown`
 * so the consumer (auth/instance.ts) is the single site that narrows.
 *
 * Both fields are optional on `Storage` because not every test fixture
 * needs to wire better-auth — leaving them unset disables the adapter
 * mount in `app.ts`.
 */
export interface BetterAuthStorageAdapter {
  /** Drizzle DB handle. Typed `unknown` here so the Storage interface
   *  stays portable; `auth/instance.ts` casts via `Parameters<typeof
   *  drizzleAdapter>[0]` so the surface is still typed at the consumer. */
  betterAuthDb: unknown;
  /** Dialect discriminator — `auth/instance.ts` uses this to pick the
   *  right Drizzle schema bundle. */
  betterAuthDialect: "sqlite" | "pg";
}

export interface Storage extends Partial<BetterAuthStorageAdapter> {
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
  outboundWebhooks: WebhookStore;
  outboundWebhookDeliveries: WebhookDeliveryStore;
  inboundWebhooks: InboundWebhookStore;
  inboundWebhookEvents: InboundWebhookEventStore;
  connectionOauthTokens: ConnectionOAuthTokenStore;
  connectionLeasedTokens: ConnectionLeasedTokenStore;
  audit: AuditStore;
  eventLog: EventLogStore;
  settings: SettingsStore;
  coordination: CoordinationStore;
  users?: UserStore;
  tenants?: TenantStore;
  /** T-052: per-tenant quotas. Always present (counts even when no
   *  per-tenant ceilings are set). */
  tenantQuotas: TenantQuotaStore;
  runInTransaction<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
