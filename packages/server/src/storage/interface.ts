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
  MarfaRole,
  PaginatedResult,
  SearchResult,
  ConflictResponse,
  ItemState,
  User,
  Tenant,
  Edge,
  CreateEdgeInput,
} from "@withmarfa/shared";
import type { EdgeTypeSchema, TypeSchema } from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

export type ItemSortField = "created_at" | "updated_at" | "timestamp";
export type SortDirection = "asc" | "desc";

export interface ItemFilters {
  tenantId?: string;
  /** Opt-in widening of the tenant filter for catalogue surfaces. When
   *  `tenantId` is set AND this flag is true, the WHERE clause becomes
   *  `(tenant_id = $tenantId OR tenant_id IS NULL)` — so platform-scoped
   *  rows (written by `is_platform: true` credentials with `tenant_id` NULL)
   *  surface to in-tenant callers alongside their own rows. Used by the
   *  Integrations catalogue list (`GET /integrations`) so registered
   *  manifests, which carry `tenant_id IS NULL` by design, are visible to
   *  any authenticated tenant member. Default off — generic list reads
   *  must NOT pick this up, or null-tenant rows from any source would
   *  leak across tenant boundaries. No effect when `tenantId` is unset. */
  includePlatformScoped?: boolean;
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
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid pagination cursor",
    );
  }
}

// ---------------------------------------------------------------------------
// Sub-store interfaces
// ---------------------------------------------------------------------------

/**
 * Optional knobs for single-item `get` lookups.
 *
 * `includePlatformScoped` mirrors `ItemFilters.includePlatformScoped` for the
 * single-id path: when set alongside a real `tenantId`, the WHERE clause
 * widens to `(tenant_id = $tenantId OR tenant_id IS NULL)` so platform-
 * scoped rows (written by `is_platform: true` credentials with
 * `tenant_id` NULL) resolve for in-tenant callers. Used by the
 * Integrations install + get-by-id endpoints, which legitimately need
 * to fetch a platform-scoped `system.integration` manifest from a
 * tenant-scoped caller. Default off — generic gets MUST NOT pick this
 * up, or null-tenant rows from any source could leak across tenants.
 * No effect when `tenantId` is undefined.
 */
export interface ItemGetOptions {
  includePlatformScoped?: boolean;
}

export interface ItemStore {
  create(input: CreateItemInput, tenantId?: string): Promise<Item>;
  get(
    id: string,
    tenantId?: string,
    options?: ItemGetOptions,
  ): Promise<Item | null>;
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
  /**
   * Hard-delete every trashed item whose `updated_at` is strictly older
   * than `beforeDate` (an ISO 8601 timestamp). Cleans the search index
   * for each row. Returns the number of rows deleted.
   *
   * `tenantId` semantics (T-050):
   * - `undefined` — every row older than the cutoff.
   * - `string` — only rows where `tenant_id` matches.
   * - `null` — only rows where `tenant_id IS NULL` (single-tenant
   *   self-host items + any rows with no tenant scope).
   */
  purgeTrashedOlderThan(
    beforeDate: string,
    tenantId?: string | null,
  ): Promise<number>;
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
   * T-117: list a single tenant's active (non-revoked) API keys. The
   * `my admin keys list <tenant>` operator surface uses this so a
   * platform-admin can discover keys for emergency revocation. Returns
   * an empty array when the tenant has no keys.
   */
  listForTenant(tenantId: string): Promise<ApiKey[]>;
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
    succeeded: boolean;
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
 * encrypted under HKDF(MARFA_AUTH_SECRET, "connection-oauth-tokens"); the
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

/** Patch shape for `UserStore.updateProfile` — covers PATCH /profile/me
 *  + avatar set/clear. `null` clears; `undefined` leaves unchanged. */
export interface UpdateProfileInput {
  first_name?: string | null;
  last_name?: string | null;
  bio?: string | null;
  avatar_blob_hash?: string | null;
}

export interface UserStore {
  create(input: {
    name?: string;
    provider: string;
    provider_id: string;
    tenant_id: string;
    /** Optional: claim a handle at creation time. The Better Auth
     *  sign-up flow (`POST /auth/sign-up/email`) always stamps it; test
     *  fixtures and admin tooling may leave it null. */
    handle?: string;
    /** Optional: bind to a Better Auth `auth_user.id`. Stamped at sign-up
     *  time by `POST /auth/sign-up/email`. T-074: this is the canonical
     *  bridge between Better Auth identity and the Marfa profile. Test
     *  fixtures and admin tooling may leave it null. */
    auth_user_id?: string;
    /** T-178: optional role on creation. No route surfaces this — sign-up
     *  flows default to `member`. Tests and the operator's escape hatch
     *  (`setRole`) use it. */
    role?: MarfaRole;
  }): Promise<User>;
  getById(id: string): Promise<User | null>;
  /** T-074: lookup by Better Auth `auth_user.id`. Replaces the previous
   *  `getByEmail` after `users.email` was dropped (single source of truth
   *  for email is `auth_user.email`). */
  getByAuthUserId(authUserId: string): Promise<User | null>;
  getByProvider(provider: string, providerId: string): Promise<User | null>;
  getByTenantId(tenantId: string): Promise<User | null>;
  /** Lookup by claimed handle (TSC42 §8). Used for collision detection. */
  getByHandle(handle: string): Promise<User | null>;
  /** Claim or change a user's handle. Throws on collision. */
  setHandle(id: string, handle: string): Promise<User>;
  /** T-178: operator-only role mutation. No route surfaces this — the
   *  current operator elevates via SQL (or via this method from a script).
   *  A real provisioning API (`my platform users set-role` etc.) lands
   *  when a second user shows up. */
  setRole(id: string, role: MarfaRole): Promise<User>;
  /** T-074: update the editable profile fields (first/last name, bio,
   *  avatar blob hash). Stamps `updated_at`. `undefined` keys are
   *  untouched; `null` clears the column. */
  updateProfile(id: string, patch: UpdateProfileInput): Promise<User>;
  /** T-074: read the canonical email + verification flag from the
   *  Better Auth `auth_user` row. Returns `null` if no row matches.
   *  Used by the profile endpoints + `/oauth/userinfo` to mirror the
   *  email field without keeping a shadow copy on `users`. */
  getAuthUserEmail(authUserId: string): Promise<{
    email: string;
    email_verified: boolean;
  } | null>;
}

export interface TenantStore {
  create(name?: string): Promise<Tenant>;
  get(id: string): Promise<Tenant | null>;
  /**
   * T-050: enumerate all tenants. Used by background cleanup jobs that
   * fan out per-tenant. Returns tenants in arbitrary order; callers
   * shouldn't depend on ordering. Cost is O(tenants) — cleanup runs
   * are off the request hot path so the unbounded scan is acceptable
   * at the scale we're targeting.
   */
  list(): Promise<Tenant[]>;
  getConfig(
    id: string,
  ): Promise<import("@withmarfa/shared").TenantConfig | null>;
  updateConfig(
    id: string,
    config: import("@withmarfa/shared").TenantConfig,
  ): Promise<void>;
  /**
   * T-117: flip tenant status. `suspend` blocks future writes at the auth
   * middleware (reads pass through); `unsuspend` restores. Both are no-ops
   * when the tenant is already at the target status. Returns the updated
   * row (null if the tenant id doesn't exist).
   */
  suspend(id: string): Promise<Tenant | null>;
  unsuspend(id: string): Promise<Tenant | null>;
  /**
   * T-117: cheap status read for the auth-middleware write-guard. Returns
   * `null` when the tenant doesn't exist (the gate treats unknown
   * tenants as `active` — the credential's own tenant_id mismatch is
   * handled separately by the standard auth flow).
   */
  getStatus(
    id: string,
  ): Promise<import("@withmarfa/shared").TenantStatus | null>;
}

/**
 * Per-tenant quota store (T-052). Stores ceilings; counts are computed
 * on-demand from existing tables at quota-check time.
 */
export interface TenantQuotaStore {
  /** Returns the per-tenant ceilings; null when no row exists (use env defaults). */
  get(
    tenantId: string,
  ): Promise<import("@withmarfa/shared").TenantQuota | null>;
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
  ): Promise<import("@withmarfa/shared").TenantQuota>;
  /** Returns the current count for a resource within a tenant. */
  count(
    tenantId: string,
    resource: import("@withmarfa/shared").QuotaResource,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// OAuth store
//
// T-131 narrowed this store to device-flow state machine + last_used
// stamping. The OAuth-protocol surfaces (clients / codes / tokens) moved
// to the @better-auth/oauth-provider plugin tables (`auth_oauth_*`); read
// helpers live on `OauthProviderStore` below.
// ---------------------------------------------------------------------------

export interface OAuthStore {
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
  }): Promise<import("@withmarfa/shared").OAuthDeviceCode>;

  /** Lookup by SHA-256 of the device_code. Used by the polling endpoint.
   *  Returns null if the row doesn't exist; expired rows are returned
   *  with `status: "pending"` (caller checks `expires_at` to decide). */
  findDeviceCodeByHash(
    hash: string,
  ): Promise<import("@withmarfa/shared").OAuthDeviceCode | null>;

  /** Lookup by user_code. Used by the verification page. */
  findDeviceCodeByUserCode(
    userCode: string,
  ): Promise<import("@withmarfa/shared").OAuthDeviceCode | null>;

  /** Stamp `last_polled_at`. Used by the polling endpoint to detect
   *  `slow_down` (client polled inside the interval window). */
  markDeviceCodePolled(id: string, now: string): Promise<void>;

  /** Flip status to `approved`, set `connection_item_id` and
   *  `approved_at`. Returns false if the row was not pending. */
  approveDeviceCode(id: string, connectionItemId: string): Promise<boolean>;

  /** Flip status to `denied`. Returns false if the row was not pending. */
  denyDeviceCode(id: string): Promise<boolean>;

  /**
   * Conditional `last_used_at` stamp on the underlying `system.connection`
   * (kind: app) for an OAuth grant. Mirrors `KeyStore.updateLastUsed` in
   * shape (T-101): the WHERE clause only writes when the existing
   * `properties.last_used_at` is NULL or older than `now - thresholdMs`,
   * so the row is updated at most once per `thresholdMs` regardless of
   * how many instances call concurrently.
   *
   * The auth middleware layers a per-process in-memory cache on top to
   * skip the DB round-trip when the calling instance has already stamped
   * inside the window — that cache is a first-line short-circuit, not
   * the authoritative throttle. Cluster-wide debounce comes from the
   * conditional UPDATE here.
   *
   * Tenant-scoped: the WHERE matches `(id, tenant_id)` so a hosted-mode
   * caller cannot trip this against another tenant's grant row. Pass
   * `null` for the unscoped (single-tenant self-host) case.
   *
   * Best-effort: callers swallow errors. The middleware-side cache mark
   * already prevents a stampede; storage failures must never break the
   * auth path.
   */
  updateLastUsedAt(
    connectionItemId: string,
    tenantId: string | null,
    thresholdMs: number,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// @better-auth/oauth-provider read helpers (T-131)
// ---------------------------------------------------------------------------

/**
 * Thin read helpers over the @better-auth/oauth-provider plugin's tables
 * (`auth_oauth_client`, `auth_oauth_consent`). Used by:
 *
 *   - the `/auth/authorize` consent route, which needs the client's
 *     friendly name and the user's prior consent (for the re-consent
 *     diff render)
 *   - the grant-projection after-hooks in `auth/oauth-provider.ts`,
 *     which need to resolve the client_id ↔ system.connection link
 *
 * Direct Drizzle reads against the plugin's tables; the plugin itself
 * is the authoritative writer. Kept as a separate store so the consent
 * route doesn't have to peek into dialect-specific Drizzle internals.
 */
export interface OauthAccessTokenRow {
  id: string;
  userId: string | null;
  clientId: string;
  /** Tenant id resolved via the plugin's `clientReference` callback at
   *  token-issuance time (mirrors `auth_oauth_access_token.reference_id`).
   *  Null in keys-mode self-hosts where no per-user tenant exists. */
  referenceId: string | null;
  scopes: string[];
  expiresAtMs: number | null;
  createdAtMs: number | null;
}

export interface OauthClientRow {
  /** Internal PK on `auth_oauth_client.id`. */
  id: string;
  /** The unique business key — what RPs identify themselves with. */
  clientId: string;
  name: string | null;
  redirectUris: string[];
  /** Tenant binding from `clientReference` (Marfa: tenant_id). */
  referenceId: string | null;
}

/**
 * T-158: input to `OauthProviderStore.createClient`, used by Marfa's
 * `POST /auth/oauth2/register` override (which fronts the plugin's DCR
 * endpoint — see `routes/oauth-register.ts`).
 *
 * The override exists because:
 *
 * 1. The plugin's DCR (`POST /auth/oauth2/register`) hardcodes a Zod enum
 *    of three grant types and rejects the device-code URN at validation
 *    time — there's no config knob to widen it (verified in
 *    `@better-auth/oauth-provider@1.6.9` `dist/index.mjs:3462-3466`).
 * 2. The plugin's DCR write path goes through Better Auth's Drizzle
 *    adapter, which sets `supportsArrays: true` for the `pg` provider
 *    (verified in `@better-auth/drizzle-adapter@1.6.9`
 *    `dist/index.mjs:434`). The adapter then passes JS arrays directly
 *    into the `text` columns (`scopes`, `redirect_uris`, `grant_types`,
 *    `response_types`, etc.). Postgres coerces those to comma-joined
 *    strings on write; on read, the plugin's `schemaToOAuth` calls
 *    `scopes?.join(" ")` on a string → `TypeError`, surfaced as HTTP 500.
 *    The Marfa schema is intentionally `text` (JSON-encoded string), not
 *    `text[]` — Marfa's own `mintTokenPair` write path uses
 *    `JSON.stringify` and the read helpers (`getClient`,
 *    `validateAccessToken`) `safeJsonParse` on the way back out. The
 *    plugin DCR is the only Better-Auth-internal writer to
 *    `auth_oauth_client`, so routing around it is sufficient.
 */
export interface CreateClientInput {
  /** The new client's business key (returned to the caller). */
  clientId: string;
  /** Friendly name for the consent screen. */
  name: string | null;
  /** Public client (PKCE, no secret) per RFC 7591 §2.3. */
  isPublic: boolean;
  /** Allowed grant types, including the device-code URN. */
  grantTypes: readonly string[];
  /** Response types — pinned to `["code"]` for `authorization_code` */
  responseTypes: readonly string[];
  /** Token endpoint auth method (`none` for public, `client_secret_*`
   *  for confidential). */
  tokenEndpointAuthMethod: string;
  /** Allowed scopes for this client (must be a subset of the server's
   *  `clientRegistrationAllowedScopes`). */
  scopes: readonly string[];
  /** Allowed redirect URIs. May be empty for clients that only run the
   *  device-code grant (no browser redirect). */
  redirectUris: readonly string[];
  /** Tenant binding from the resolver — null for unauthenticated /
   *  keys-mode DCR. Mirrors `clientReference` in the plugin's wiring. */
  referenceId: string | null;
  /** Optional client metadata fields (passed through to the row). */
  clientUri?: string | null;
  logoUri?: string | null;
  tosUri?: string | null;
  policyUri?: string | null;
  contacts?: readonly string[] | null;
  softwareId?: string | null;
  softwareVersion?: string | null;
  softwareStatement?: string | null;
  type?: string | null;
}

export interface CreateClientResult {
  /** The internal PK on `auth_oauth_client.id`. */
  id: string;
  /** Echoed back from `input.clientId`. */
  clientId: string;
  /** Issued-at, unix seconds. */
  clientIdIssuedAt: number;
}

export interface MintTokenPairInput {
  /** The pre-computed hash of the access-token string (output of
   *  `storeTokens.hash` = `hashApiKey(token, salt)`). The plugin's
   *  bearer middleware looks this up by exact match. */
  accessTokenHash: string;
  /** Pre-computed hash of the refresh-token string. */
  refreshTokenHash: string;
  clientId: string;
  authUserId: string;
  referenceId: string | null;
  scopes: string[];
  /** TTL milliseconds for the access token. The refresh token gets
   *  a longer TTL set inside the implementation (mirrors the plugin's
   *  default 30d). */
  accessTtlMs: number;
}

export interface OauthProviderStore {
  /** Look up a registered client's friendly name by its `client_id`.
   *  Returns `undefined` if the client doesn't exist. */
  getClientName(clientId: string): Promise<string | undefined>;
  /** Full client row by business key. Used by the device-flow initiation
   *  path to validate `redirect_uri` and resolve a display name. */
  getClient(clientId: string): Promise<OauthClientRow | null>;
  /** Look up the user's most recent prior consent scopes for
   *  (clientId, authUserId). Returns the scope literals from the
   *  `auth_oauth_consent` row, or `undefined` if no prior grant. */
  getPriorConsent(
    clientId: string,
    authUserId: string,
  ): Promise<readonly string[] | undefined>;
  /** T-131: bearer-middleware lookup over `auth_oauth_access_token`.
   *  Returns the row keyed by the hashed token output of `storeTokens.hash`
   *  (which is `hashApiKey(token, salt)`), or null if the token isn't
   *  recognised or has expired. Powers the bearer-middleware side-channel
   *  join — see plan §Caveats §3 (opaque tokens carry no embedded claims,
   *  so we read the row directly). */
  validateAccessToken(tokenHash: string): Promise<OauthAccessTokenRow | null>;
  /** Cascade revocation for a grant: delete every access + refresh token
   *  for (clientId, authUserId). Used by the `/auth/grants/:id/revoke`
   *  handler when the user revokes an app's access. The grant's
   *  `auth_oauth_consent` row is also deleted (the plugin will require
   *  re-consent on the next authorize attempt). */
  revokeTokensForGrant(clientId: string, authUserId: string): Promise<void>;
  /**
   * T-131 follow-on (refresh-replay): delete ONLY access tokens for a
   * grant — leaves refresh tokens + consent intact. Used by the
   * `/oauth2/token` before-hook on refresh-token replay detection: the
   * plugin's own logic deletes the refresh chain on stale-refresh
   * detection but leaves access tokens valid until their TTL (default
   * 1h). This narrows that window to zero by zapping access tokens
   * pre-emptively when we detect a revoked refresh in the request.
   *
   * Idempotent — re-calling on an already-cleaned grant is a no-op.
   * Best-effort; callers swallow errors.
   */
  revokeAccessTokensForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void>;
  /**
   * T-131 follow-on (refresh-replay): look up a refresh-token row by its
   * hashed `token` column value. Returns the (clientId, userId, revoked)
   * tuple needed to decide whether the request is a replay attempt and
   * whose access tokens to nuke. Returns null if the token doesn't
   * exist (e.g. already deleted by a prior chain-revocation pass).
   */
  findRefreshTokenGrantKey(tokenHash: string): Promise<{
    clientId: string;
    userId: string;
    revoked: boolean;
  } | null>;
  /** Insert an access + refresh token pair from the device-flow terminal
   *  step. Writes into `auth_oauth_access_token` + `auth_oauth_refresh_token`
   *  with the same shape the plugin's `/oauth2/token` path would produce,
   *  so the bearer middleware resolves them uniformly. */
  mintTokenPair(input: MintTokenPairInput): Promise<void>;
  /** T-158: insert a row into `auth_oauth_client` with JSON-encoded
   *  string[] columns matching the rest of Marfa's write paths (see
   *  `CreateClientInput` for the upstream-bug context). Used exclusively
   *  by the Marfa-owned `POST /auth/oauth2/register` route in
   *  `routes/oauth-register.ts`; the plugin's own DCR endpoint is NOT
   *  exercised on Marfa deployments. */
  createClient(input: CreateClientInput): Promise<CreateClientResult>;
  /** T-158: existence check on `(clientId)` for the registration route
   *  to surface a clean 409 instead of a Postgres unique-violation. */
  clientExists(clientId: string): Promise<boolean>;
  /**
   * T-131 follow-on: resolve the projected `system.connection { kind: "app" }`
   * item id for a (tenantId, clientId, authUserId) tuple. Returns the
   * `items.id` value or `null` if no projection exists (consent never ran,
   * or the row was hard-deleted).
   *
   * Used by the bearer middleware to find the `system.connection` row it
   * needs to stamp `last_used_at` on, and by the re-consent path to update
   * the row's `scopes` property when the user grants a different scope set.
   *
   * Single-row indexed query: matches on `(type, tenant_id)` and predicates
   * on `properties.kind / .client_id / .user_id` via the dialect's JSON
   * extractor. Sub-ms in PG, sub-ms in SQLite.
   *
   * Tenant-scoped: pass `null` for the unscoped (single-tenant self-host)
   * case so the row's `tenant_id IS NULL` predicate is used. A hosted-mode
   * caller passing a real tenant cannot cross-tenant-match.
   */
  findGrantItemId(opts: {
    tenantId: string | null;
    clientId: string;
    authUserId: string;
  }): Promise<string | null>;
}

// T-131 review-sweep Commit 2 / F6: `OauthProviderStore.updateGrantScopes`
// was dropped. The re-consent path now updates the projection via the
// standard `storage.items.update` route (writes a `versions` snapshot,
// bumps `updated_at` + `version`, lets the projection participate in
// `/items?sort=updated_at` correctly). See `projectGrantOnConsent` in
// `routes/auth-consent.ts`.

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
  /**
   * Hard-delete rows whose `timestamp` is older than the retention
   * window. T-050 added the optional `tenantId` filter so the cleanup
   * job can fan out per-tenant honouring per-tenant retention
   * overrides:
   *
   * - `undefined` — every row older than the cutoff (unscoped sweep).
   * - `string` — only rows where `tenant_id` matches.
   * - `null` — only rows where `tenant_id IS NULL` (system-initiated
   *   audits + the no-tenant rows that single-tenant self-hosts use).
   *
   * Returns the number of rows actually deleted.
   */
  cleanup(retentionDays: number, tenantId?: string | null): Promise<number>;
  /**
   * T-116: redact rows that identify a specific `auth_user.id` ahead of
   * a hard-delete of the account. Rewrites `audit_log.details` to
   * `{ redacted: true, user_id_sha256: <hex> }` for every row whose
   * `resource_id === authUserId` OR whose `details` JSON object
   * contains any field whose value equals `authUserId` (exact-equality
   * match — substring matches are ignored to avoid false positives).
   *
   * The row's `action`, `resource_type`, `timestamp`, and `id` are
   * preserved — the audit chain remains intact; only personally
   * identifying payload is scrubbed.
   *
   * Returns the number of rows rewritten.
   */
  redactForUser(authUserId: string): Promise<number>;
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
  /** Populated on item events; null on edge events — the column is
   *  nullable so edge events don't have to borrow source_id. */
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

  /**
   * Delete events older than the given retention window. Same
   * `tenantId` semantics as `AuditStore.cleanup` (T-050): undefined
   * sweeps everything, a string scopes to that tenant, `null` scopes
   * to rows whose `tenant_id IS NULL`. Returns count deleted.
   */
  cleanup(retentionHours: number, tenantId?: string | null): Promise<number>;

  /** Smallest surviving event id, scoped to a tenant when provided.
   *  Returns null when no events match. Used by the SSE route to
   *  detect clients whose `Last-Event-ID` predates the retention
   *  window so it can emit a terminal `catchup_too_old` event
   *  instead of silently resuming mid-stream. */
  getMinRetainedId(tenantId?: string): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------
// Settings store (instance-wide KV for bootstrap sentinel etc.)
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
  /**
   * Batched `deleteBySource` — drop every edge whose `source_id` is in
   * `sourceIds`, optionally filtered by `edge_type`. Single SQL DELETE per
   * call regardless of how many ids are passed. Returns the number of
   * rows deleted; an empty `sourceIds` is a 0-row no-op. Used by the
   * bulk-action purge worker so 100 items' worth of outbound edges drop
   * in one statement instead of 100.
   */
  deleteBySourceBatch(sourceIds: string[], edgeType?: string): Promise<number>;
  /** Mirror of `deleteBySourceBatch` for inbound edges. */
  deleteByTargetBatch(targetIds: string[], edgeType?: string): Promise<number>;
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
/**
 * T-097: cleanup hooks for the better-auth `auth_session` table. Better
 * Auth itself owns the session TTL via `expiresAt`; this store exists
 * only to drop rows past that timestamp on a periodic sweep so the
 * table doesn't grow unbounded across hosted multi-tenant scale.
 *
 * Instance-wide by design — `auth_session` carries no `tenant_id`
 * column, the deletion criterion is purely time-based, and there's no
 * per-tenant retention knob. Mirrors the `VersionThinner` shape rather
 * than the `T-050` per-tenant fan-out used for retention-window jobs.
 */
export interface AuthSessionStore {
  /** Delete every `auth_session` row whose `expires_at` is strictly
   *  before `now`. Returns the number of rows deleted. */
  deleteExpired(now: Date): Promise<number>;
}

/**
 * T-116: account-lifecycle store. Surfaces the `auth_user.deletion_state`
 * + `pending_deletion_at` columns added to better-auth's `auth_user`
 * table for the GDPR account-deletion lifecycle. Grouped under a single
 * sub-interface (rather than scattered as top-level methods on
 * `Storage`) so the route layer reads as
 * `storage.accountLifecycle.markPendingDeletion(...)` and the surface
 * is greppable as a unit.
 *
 * The hard-delete cascade itself is a top-level `Storage` method
 * (`deleteAccountCascade`) because it spans every per-tenant table
 * plus the auth island — it doesn't sit cleanly inside one sub-store.
 * The cascade re-checks `deletion_state === 'pending_deletion'` and
 * `pending_deletion_at < cutoffIso` inside its transaction (with
 * `FOR UPDATE` on PG to serialise against the cancel route's
 * `cancelPendingDeletion` UPDATE), and short-circuits if either
 * predicate is no longer true (T-136 race fix).
 */
export interface AccountLifecycleStore {
  /** Flip `auth_user.deletion_state` → `'pending_deletion'`, stamp
   *  `pending_deletion_at = nowIso`, AND inside the same transaction:
   *  revoke every `api_keys` row for the user's tenant + delete every
   *  `auth_session` for the user. Idempotent — re-running on a
   *  pending row just re-stamps `pending_deletion_at`. */
  markPendingDeletion(authUserId: string, nowIso: string): Promise<void>;
  /** Flip the state back to `'active'` and clear `pending_deletion_at`.
   *  Returns `true` when a row was actually flipped; `false` when the
   *  UPDATE matched zero rows (account already cancelled or — the case
   *  this signal exists for, T-141 — already hard-deleted by a cascade
   *  that won the race). The cancel routes branch on the return:
   *  `true` → standard "Account restored" confirmation; `false` →
   *  "already permanently deleted" themed page + distinct audit action
   *  so the operator-facing trail is honest. */
  cancelPendingDeletion(authUserId: string): Promise<boolean>;
  /** Read the lifecycle row by `auth_user.id`. Returns null when no
   *  matching row exists. */
  getAccountLifecycle(authUserId: string): Promise<{
    deletion_state: "active" | "pending_deletion";
    pending_deletion_at: string | null;
  } | null>;
  /** Pre-sign-in middleware lookup keyed by lower-cased email. */
  getAccountLifecycleByEmail(email: string): Promise<{
    auth_user_id: string;
    deletion_state: "active" | "pending_deletion";
    pending_deletion_at: string | null;
  } | null>;
  /** Purger fan-out — every account whose `pending_deletion_at` is
   *  strictly older than `cutoffIso` and still in `pending_deletion`. */
  listPendingDeletionDue(
    cutoffIso: string,
  ): Promise<{ auth_user_id: string }[]>;
}

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
 * T-026: cluster-shared rate-limit + per-email throttle counters.
 *
 * Backing table `rate_limit_windows` keyed on (family, window_key). Two
 * production consumers ride the same store:
 *
 *   - `rate-limit middleware` (family = "rate") — per-credential and
 *     per-tenant request windows. Window keys take the shape
 *     "<credential-id-or-ip>:<path-prefix>" and "tenant:<tenant-id>";
 *     window size from `AppConfig.rateLimitWindowMs` (default 60s).
 *   - `forgot-password per-email throttle` (family = "throttle") —
 *     window key "forgot-password:<lowercased-email>"; window size 1h.
 *
 * The single primitive — atomic increment-counter-bounded-by-window —
 * services both. Production storage (PG + SQLite) implements via
 * `INSERT ... ON CONFLICT DO UPDATE` so two server instances pointed at
 * the same DB share counters cluster-wide. SQLite is single-process by
 * file lock so "shared" collapses to "still correct in-process" — same
 * code path, same semantics.
 *
 * Hot path: one DB round-trip per gated request. Acceptable at target
 * scale (low-thousands of req/s peak); PG handles tens of thousands of
 * single-row upserts per second on commodity hardware. A write-through
 * per-instance cache (mirror of the T-101 `last_used_at` shape — local
 * short-circuit + DB conditional as the authoritative floor) is a
 * future optimisation if perf measurement justifies it.
 */
export interface RateLimitStore {
  /**
   * Atomic upsert that increments the counter for `(family, key)` by 1.
   * If the existing row's `expires_at` has already passed, the row is
   * reset (count → 1, expires_at → nowIso + windowMs) before the
   * increment is applied; otherwise the increment lands on the
   * existing row and `expires_at` is left unchanged. Returns the
   * post-increment count and the row's current `expires_at`.
   *
   * Callers compare `count` against their cap and reject when over.
   * The single-row UPDATE serialises concurrent writers via Postgres
   * row-level locking (and via SQLite's BEGIN IMMEDIATE on libsql), so
   * two instances racing the same key cannot both observe `count == 1`
   * inside one window.
   */
  incrementWindow(
    family: string,
    key: string,
    windowMs: number,
    nowIso: string,
  ): Promise<{ count: number; expires_at: string }>;
  /**
   * Drop every row whose `expires_at` is strictly older than `nowIso`.
   * Called from the `RateLimitWindowCleaner` retention sweep. Returns
   * the number of rows deleted.
   */
  cleanup(nowIso: string): Promise<number>;
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

// ---------------------------------------------------------------------------
// bulk_action_jobs store (T-218 async substrate)
// ---------------------------------------------------------------------------

export type BulkActionJobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

/** Server-side row shape for a `bulk_action_jobs` entry. The SDK-facing
 *  envelope (`BulkActionJob` in `@withmarfa/sdk/client`) is a strict subset
 *  — fields like `matched_ids`, `worker_id`, `worker_heartbeat_at`,
 *  `api_key_id`, and the original `input` are server-internal. */
export interface BulkActionJobRow {
  id: string;
  tenant_id: string | null;
  api_key_id: string | null;
  status: BulkActionJobStatus;
  action: string;
  /** Original BulkActionInput, JSON-encoded. */
  input: string;
  /** Frozen matched id list, JSON-encoded `string[]`. */
  matched_ids: string;
  matched_count: number;
  processed_count: number;
  succeeded_count: number;
  errored_count: number;
  /** Final BulkActionResult envelope, JSON-encoded. Populated on
   *  `completed`. */
  result: string | null;
  /** Failure reason on `failed`. */
  error: string | null;
  worker_id: string | null;
  worker_heartbeat_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreateBulkActionJobInput {
  id: string;
  tenant_id: string | null;
  api_key_id: string | null;
  action: string;
  input: string;
  matched_ids: string;
  matched_count: number;
  idempotency_key: string | null;
  created_at: string;
}

export interface BulkActionJobProgress {
  processed_count: number;
  succeeded_count: number;
  errored_count: number;
}

export interface BulkActionJobStore {
  /**
   * INSERT a fresh row in `queued` state. When `idempotency_key` is set
   * and a row with the same `(tenant_id, idempotency_key)` already
   * exists, returns that existing row instead of creating a new one
   * — the `ON CONFLICT` happens at the unique-index level so this is a
   * race-safe replay path.
   */
  create(input: CreateBulkActionJobInput): Promise<BulkActionJobRow>;
  /** Fetch by id. Tenant scoping is the caller's responsibility — the
   *  store returns the row regardless. The route handler enforces auth
   *  (`api_key_id` match or admin). */
  getById(id: string): Promise<BulkActionJobRow | null>;
  /**
   * Atomically claim the next queued job. On Postgres, wraps a single
   * UPDATE in `SELECT … FOR UPDATE SKIP LOCKED` so multiple server
   * processes coordinate naturally. Sets `status='in_progress'`,
   * `started_at`, `worker_id`, `worker_heartbeat_at`. Returns the
   * claimed row, or `null` if the queue is empty.
   *
   * SQLite has no FOR UPDATE — single-process by design, so a plain
   * `UPDATE WHERE status='queued' RETURNING …` with `LIMIT 1` suffices.
   */
  claimNext(workerId: string, now: string): Promise<BulkActionJobRow | null>;
  /** Bump progress counts + heartbeat. Idempotent — over-writes
   *  whatever was there before, doesn't sum. */
  updateProgress(
    id: string,
    progress: BulkActionJobProgress,
    heartbeatAt: string,
  ): Promise<void>;
  /** Terminal `completed`. Writes the result envelope, sets
   *  `finished_at`, clears `worker_heartbeat_at`. */
  complete(
    id: string,
    result: string,
    finalCounts: BulkActionJobProgress,
    finishedAt: string,
  ): Promise<void>;
  /** Terminal `failed`. Writes the error string, sets `finished_at`. */
  fail(id: string, error: string, finishedAt: string): Promise<void>;
  /** Request cancellation. Flips `queued` or `in_progress` rows to
   *  `cancelled`; no-op (returns `false`) on already-terminal rows.
   *  The worker observes the flag between chunks. */
  cancel(id: string, finishedAt: string): Promise<boolean>;
  /**
   * Boot-time recovery: any `in_progress` job whose
   * `worker_heartbeat_at` is older than `staleBeforeIso` is reset to
   * `queued`. Returns the number of rows reset. Called once on server
   * boot before the worker loop starts.
   */
  recoverStale(staleBeforeIso: string): Promise<number>;
  /**
   * GC: drop terminal rows whose `finished_at` is older than
   * `expireBeforeIso`. Returns the number of rows deleted. Called by
   * the maintenance sweep on the same cadence as `purgeTrashedOlderThan`.
   */
  gcExpired(expireBeforeIso: string): Promise<number>;
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
  /** T-131: thin lookup helpers over the @better-auth/oauth-provider
   *  plugin's tables (`auth_oauth_client`, `auth_oauth_consent`).
   *  Used by the consent route + grant-projection after-hooks.
   *  Optional — test contexts that skip the OAuth surface can omit. */
  oauthProvider?: OauthProviderStore;
  outboundWebhooks: WebhookStore;
  outboundWebhookDeliveries: WebhookDeliveryStore;
  inboundWebhooks: InboundWebhookStore;
  inboundWebhookEvents: InboundWebhookEventStore;
  connectionOauthTokens: ConnectionOAuthTokenStore;
  connectionLeasedTokens: ConnectionLeasedTokenStore;
  audit: AuditStore;
  eventLog: EventLogStore;
  /** T-097: optional sweep store for expired better-auth session rows.
   *  Absent on test contexts that don't wire better-auth (the cleanup
   *  job in `index.ts` is gated on this being present). */
  authSessions?: AuthSessionStore;
  /** T-116: account-lifecycle store (delete state + pending stamp).
   *  Always wired by both dialect factories; the route layer + the
   *  purger consult it. Marked optional only because in-tree test
   *  stubs that pre-date T-116 may not implement it; production
   *  Storage always exposes it. */
  accountLifecycle?: AccountLifecycleStore;
  settings: SettingsStore;
  coordination: CoordinationStore;
  /** T-218: async substrate for `POST /items/bulk-actions`. Always wired
   *  on both dialects. The worker module reads + writes through this
   *  store; the route handler creates jobs + serves GET / DELETE. */
  bulkActionJobs: BulkActionJobStore;

  users?: UserStore;
  tenants?: TenantStore;
  /** T-052: per-tenant quotas. Always present (counts even when no
   *  per-tenant ceilings are set). */
  tenantQuotas: TenantQuotaStore;
  /**
   * T-026: cluster-shared rate-limit + per-email throttle counters.
   * Always wired by both dialect factories; the middleware + the
   * forgot-password route consult it. Required (not optional) because
   * the rate-limit middleware can't degrade gracefully without it —
   * a missing store would silently degrade to "no rate limit", which
   * is the wrong default.
   */
  rateLimits: RateLimitStore;
  /**
   * T-025 part 2: optional reference to the wrapped Postgres Drizzle
   * instance, exposed so the RLS middleware can drive
   * `db.transaction(...)` directly. Set only on the PG storage; left
   * `undefined` on SQLite (RLS is PG-only). The middleware skips the
   * role-switch wrapping when this is undefined.
   *
   * Typed `unknown` here for the same reason as `betterAuthDb`:
   * keeps the cross-dialect Storage interface portable. The
   * middleware casts via the PgDb type at consumer-site.
   */
  pgDb?: unknown;
  /**
   * T-146: optional reference to the underlying postgres-js client.
   * Exposed so streaming routes can `client.reserve()` a dedicated
   * pool connection for session-level RLS (the per-request middleware
   * uses a transaction; streams can't hold one open). Set only on
   * the PG storage; left `undefined` on SQLite. Typed `unknown` for
   * the same portability reason as `pgDb`; consumer-site casts to
   * `PgClient`.
   */
  pgClient?: unknown;
  runInTransaction<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * T-116: hard-delete every artefact tied to the given `auth_user.id`.
   * Single transaction; rollback on any failure. Order:
   *
   *   1. Resolve `tenant_id` via `users.auth_user_id`.
   *   2. Revoke OAuth tokens / leased tokens / inbound webhooks for the
   *      tenant.
   *   3. Bulk-purge items (FK-cascades metadata + versions), preceded
   *      by edge teardown per item.
   *   4. Sweep tenant-scoped blobs.
   *   5. Delete `api_keys`, `outbound_webhooks`, `inbound_webhooks`,
   *      `tenant_quotas`, `auth_verification` rows, the `users` row,
   *      the `tenants` row.
   *   6. Emit `auth.account.hard_deleted` audit BEFORE redactForUser.
   *   7. `audit.redactForUser(authUserId)` to scrub PII from the
   *      remaining audit trail.
   *   8. Delete the `auth_user` row — FK cascades drop sessions,
   *      accounts, passkeys.
   */
  /**
   * T-116 + T-136: hard-delete cascade for an `auth_user`. Re-checks
   * inside its own transaction that the account is still
   * `pending_deletion` and `pending_deletion_at < cutoffIso` before
   * proceeding — short-circuits and returns `false` if either is no
   * longer true (e.g., the user clicked cancel between
   * `listPendingDeletionDue` and the cascade). On a clean run returns
   * `true`. The PG impl uses `SELECT ... FOR UPDATE` so a concurrent
   * `cancelPendingDeletion` blocks until the cascade either commits or
   * the re-check skips.
   */
  deleteAccountCascade(authUserId: string, cutoffIso: string): Promise<boolean>;
  close(): Promise<void>;
}
