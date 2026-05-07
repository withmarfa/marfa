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

/**
 * API key roles.
 *
 * - `admin` — platform admin (single-tenant compat: full instance authority).
 *   Bypasses every permission map. Used for system config, cross-tenant ops,
 *   minting platform credentials.
 * - `workspace_admin` — tenant-bounded admin (T-051). Full admin authority
 *   *within the calling key's `tenant_id`*: own keys, webhooks, types,
 *   connections, extensions. Cannot cross-tenant read/write (RLS-enforced),
 *   cannot mint platform credentials, cannot touch system config. Routes that
 *   accept this role gate with `requireWorkspaceAdmin(c)` (admits both tiers);
 *   routes that need platform authority retain `requireAdmin(c)`.
 * - `member` — non-admin credential. Bound by `type_permissions` /
 *   `edge_permissions` / `extension_permissions` / `metadata_permissions`.
 */
export type KeyRole = "admin" | "workspace_admin" | "member";

/** Valid role values as a readonly array, useful for validation. */
export const KEY_ROLES: readonly KeyRole[] = [
  "admin",
  "workspace_admin",
  "member",
] as const;

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
  /**
   * Tenant scope. Optional because storage queries are tenant-scoped at
   * the SQL layer (`tenantWhere` enforces a `WHERE tenant_id = ?` on every
   * read), so for ordinary callers `tenant_id` always matches the caller's
   * own tenant and the field is informational. Internal cross-tenant
   * infrastructure (the reactive-run bridge — T-042) reads this to gate
   * fanout on tenant match. Mirrors `Edge.tenant_id`.
   */
  tenant_id?: string | null;
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
 * `packages/types/core/edges/*.json` for semantics per edge type.
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

/**
 * Per-metadata-sub-resource permission levels. Today the only sub-resource
 * is `types` (gating type registration via `POST /types`); future entries
 * (e.g. tenant config) follow the same shape. Default `{}` — no access —
 * means non-admin/non-platform credentials cannot mutate the metadata
 * surface.
 */
export type MetadataPermission = "read" | "write";

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
  /**
   * Connections runtime credential gate (Workstream 3 Layer 1). When
   * `true`, the credential was minted by the control-plane lease broker
   * for a specific Connection's runtime. The extension write gate
   * narrows such credentials to writing only the `connection.runtime`
   * subtree of the item whose id matches `connection_id`.
   *
   * Defaults to `false` for every other credential type. The mint route
   * (`POST /system/runtime-credentials`) is the only path that flips
   * this flag; ordinary key creation cannot.
   */
  is_runtime_credential?: boolean;
  /**
   * Set when `is_runtime_credential` is `true`. Stamps the Connection
   * the credential was minted for. The extension gate compares this
   * against the path `:id` for cross-tenant denial.
   */
  connection_id?: string;
  /**
   * Per-credential schema-enforcement override (TSC42 §5). Same shape as
   * `TenantConfig.enforcement`; entries here merge over the tenant default
   * for this credential's writes/reads. Optional — most credentials inherit
   * tenant config without override.
   */
  enforcement_override?: EnforcementSettings;
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
  /**
   * Per-metadata-sub-resource permissions map. Today only `types` is
   * surfaced (gates `POST /types` for non-admin credentials). Empty
   * object means no metadata permissions granted; admin keys bypass the
   * map entirely. OAuth tokens carry the same map projected from the
   * grant's `metadata.<subresource>:<verb>` scopes.
   */
  metadata_permissions?: Record<string, MetadataPermission>;
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
  metadata_permissions?: Record<string, MetadataPermission>;
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
  metadata_permissions?: Record<string, MetadataPermission>;
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

/**
 * A user's approval for a client — records which scopes were granted.
 *
 * PR 4 of workstream 1 moved the durable grant record onto `system.connection`
 * items (kind: app). The `id` field below is the underlying item
 * id; subsequent OAuth records (codes, tokens) reference it as
 * `connection_item_id`.
 */
export interface OAuthGrant {
  id: string;
  client_id: string;
  scopes: string[];
  created_at: string;
}

/** An OAuth access or refresh token record (without raw token value). */
export interface OAuthToken {
  id: string;
  /** id of the system.connection item this token was issued under. */
  connection_item_id: string;
  token_type: OAuthTokenType;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** A short-lived authorization code issued during the consent flow. */
export interface OAuthCode {
  id: string;
  /** id of the system.connection item this code was minted against. */
  connection_item_id: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/**
 * Device Authorization Grant (RFC 8628) — pairing record between a
 * client polling for tokens and a human-driven approval flow.
 *
 * The client receives `device_code` (kept private, hashed at storage)
 * and `user_code` (short, low-entropy, shown to the human). The user
 * visits `verification_uri`, types in `user_code`, signs in, and
 * approves the requested scopes; the client polls
 * `POST /auth/device/token` with `device_code` until approved.
 *
 * `connection_item_id` is set when status transitions to `approved`
 * (the `system.connection` of kind `app` created at approval time).
 */
export interface OAuthDeviceCode {
  id: string;
  user_code: string;
  client_id: string;
  scopes: string[];
  status: OAuthDeviceCodeStatus;
  /** Set when status transitions to `approved`. Null otherwise. */
  connection_item_id: string | null;
  expires_at: string;
  /** Minimum seconds the client should wait between token-endpoint polls. */
  interval_seconds: number;
  /** Last time the client polled. Used for `slow_down` detection. */
  last_polled_at: string | null;
  approved_at: string | null;
  created_at: string;
}

export type OAuthDeviceCodeStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired";

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

/**
 * Inbound webhook subscription — workstream 2 PR 5.
 *
 * Inbound webhooks are external services posting into Myme via
 * `POST /webhooks/inbound/:id`. Each subscription belongs to a
 * `system.connection` of kind `integration` and stamps
 * its verification method (read from the Integration manifest) at
 * creation time. The raw shared secret is returned ONLY in the create
 * response; subsequent reads always redact it.
 */
export interface InboundWebhook {
  id: string;
  tenant_id?: string;
  connection_id: string;
  external_service_id?: string;
  /**
   * Redacted shared-secret marker for list/get responses (`****<last 4>`).
   * The raw secret is only ever surfaced in the 201 create response,
   * which uses the `secret` field on `CreatedInboundWebhook` below.
   */
  secret_redacted: string;
  verification_method: "hmac-sha256" | "slack" | "stripe" | "github";
  /**
   * Carried over from the WS2 era when `verification_method: "custom"`
   * shipped with a per-row `adapter_id`. The custom method was dropped
   * in T-011 (the runtime never resolved it); the column is still on
   * the table for backwards data compatibility but is always undefined
   * on writes going forward. Will be removed in a follow-up migration.
   */
  verification_adapter_id?: string;
  events: string[];
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Returned exactly once by `POST /connections/:id/inbound-webhooks` —
 * extends the standard `InboundWebhook` shape with the raw `secret`
 * the caller must transmit to the external service. Subsequent reads
 * never re-surface it.
 */
export interface CreatedInboundWebhook extends InboundWebhook {
  secret: string;
}

/** Input for registering an inbound webhook subscription. */
export interface CreateInboundWebhookInput {
  /** The external service's id for this subscription, optional. */
  external_service_id?: string;
  /** Subscribed event types — opaque strings the connector understands. */
  events: string[];
  /**
   * The Integration manifest, inline. Validated via
   * `validateManifest`; the verification method (and adapter_id when
   * `method: custom`) is stamped on the new row.
   *
   * Typed as `unknown` here because the shape is enforced by
   * `IntegrationManifestSchema` at validate time — the wire surface
   * accepts anything; the route rejects with the structured error
   * array on shape mismatch.
   */
  manifest: unknown;
}

/** A single inbound webhook receipt — one row per POST to `/webhooks/inbound/:id`. */
export interface InboundWebhookEvent {
  id: string;
  inbound_webhook_id: string;
  external_delivery_id: string;
  received_at: string;
  /** Raw request body as received (UTF-8 string). */
  payload: string;
  verified: boolean;
  /** NULL until WS3's reactive runner finishes processing. */
  processed_at: string | null;
  /** NULL until retries are exhausted (DLQ). */
  processing_error: string | null;
  retry_count: number;
  next_attempt_at: string | null;
}

/**
 * Wire view of a leased bearer token issued to a connector for one of the
 * four exception cases the OAuth proxy doesn't cover (multipart streaming,
 * WebSocket, SDK lock-in, non-HTTP). The lease IS a bearer token; storage
 * is hashed (SHA-256) like API keys, plaintext is returned ONCE on issue.
 * (workstream 2 PR 7)
 */
export interface ConnectionLeasedToken {
  id: string;
  connection_id: string;
  tenant_id: string | null;
  capability_id: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/**
 * Extends `ConnectionLeasedToken` with the raw `lease_token` field —
 * returned once in the 201 response to `POST /connections/:id/lease-token`,
 * never echoed by subsequent reads.
 */
export interface CreatedConnectionLeasedToken extends ConnectionLeasedToken {
  /** Plaintext bearer; pass to validate / use against the upstream. */
  lease_token: string;
}

/**
 * Wire shape returned by `POST /connections/install`. The JSON install
 * sibling of the HTML consent flow at `POST /integrations/:id/install` —
 * skips the human-consent step (no browser approval) and is admin-only.
 * Used by operator workflows: T-040 soak seeding, the CLI's
 * `my connections install` command. Returns the connection id, the seed
 * runtime credential id, and the system.activity row id from the install
 * pipeline.
 */
export interface ConnectionInstallResult {
  connection_id: string;
  /** id of the seed runtime credential minted bound to the new connection. */
  credential_id: string;
  /** id of the system.activity row emitted by the pipeline. */
  activity_id: string;
}

/**
 * Wire shape returned by `POST /connections/:id/uninstall`. Records the
 * artefacts the orchestrated uninstall pipeline cleaned up — the runtime
 * credentials it revoked, whether an upstream OAuth tokens row was
 * deleted, and counts for leased tokens revoked / inbound webhooks
 * disabled. The system.activity row id is included so callers can
 * correlate the uninstall with the operator-visible activity feed.
 */
export interface ConnectionUninstallResult {
  connection_id: string;
  /** ids of every runtime credential revoked. Usually one. */
  revoked_credential_ids: string[];
  /** True when a `connection_oauth_tokens` row was deleted. */
  oauth_tokens_deleted: boolean;
  /** Number of `connection_leased_tokens` rows revoked. */
  leased_tokens_revoked: number;
  /** Number of `inbound_webhooks` subscriptions disabled. */
  inbound_webhooks_disabled: number;
  /** id of the system.activity row emitted by the pipeline. */
  activity_id: string;
}

/**
 * RFC 7662-shaped introspection response from
 * `POST /lease-tokens/validate`. `active: false` when the lease is
 * unknown, expired, or revoked; the route returns 200 in either case so
 * relying parties can branch on the boolean rather than catching errors.
 */
export interface LeaseTokenIntrospection {
  active: boolean;
  connection_id?: string;
  capability_id?: string;
  scopes?: string[];
  expires_at?: string;
}

/**
 * Wire view of a stored OAuth token for an external-service connector.
 * Tokens are encrypted at rest server-side; the wire view reveals only
 * the metadata necessary for admin/observability surfaces. The
 * `access_token` and `refresh_token` fields are *intentionally*
 * absent — there is no API that returns them in plaintext. The proxy
 * route is the only path through which the access token influences a
 * request, and that path forwards to the upstream rather than echoing
 * to the caller. (workstream 2 PR 6)
 */
export interface ConnectionOAuthToken {
  id: string;
  connection_id: string;
  tenant_id: string | null;
  expires_at: string;
  scopes: string[];
  /** True when a refresh token is present — the proxy can self-heal on 401. */
  has_refresh_token: boolean;
  created_at: string;
  updated_at: string;
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

/**
 * Schema-enforcement levers (TSC42 §5). All three default off; flip on
 * per-type to tighten validation. Applied tenant-wide by default; per-
 * credential override available via `ApiKey.enforcement_override`.
 *
 * - `strict_mode.types` — type IDs where unknown properties are rejected
 *   on write (z.strictObject vs z.looseObject).
 * - `source_allowlist` — for the listed types, only items written from
 *   one of `sources` are accepted; everything else is rejected.
 * - `source_filter` — for the listed types, reads return only items
 *   whose source matches `sources`. Filter-only, not enforcement-on-write.
 */
export interface EnforcementSettings {
  strict_mode?: { types: string[] };
  source_allowlist?: { types: string[]; sources: string[] };
  source_filter?: { types: string[]; sources: string[] };
}

/**
 * Per-tenant resource quotas (T-052). Empty / missing limits fall back to
 * the instance defaults from env (`MYME_DEFAULT_QUOTA_*`). Quotas are
 * platform-admin-managed via `GET/PUT /admin/tenants/:id/quotas`; tenant-
 * own reads land via `GET /tenants/me/quotas` (workspace_admin or admin).
 *
 * Counts (e.g. `items_count`) are computed on-demand from existing tables
 * at quota-check time. The plan's eager-increment + daily reconcile
 * design is filed as a follow-on once load measurement justifies the
 * complexity — for now, COUNT(*) on hot paths is fast enough at the
 * scale we're targeting and avoids drift entirely.
 */
export interface TenantQuota {
  tenant_id: string;
  items_limit?: number | null;
  webhooks_limit?: number | null;
  blobs_limit?: number | null;
  /** Storage bytes ceiling. Optional / not enforced in this PR — counter
   *  + reconcile job filed as a follow-on. */
  storage_bytes_limit?: number | null;
  /** Per-tenant request-rate ceiling (additional to the per-credential
   *  global rate limit). Not enforced in this PR. */
  rate_per_minute_limit?: number | null;
  updated_at: string;
}

/** Resource categories that participate in T-052 enforcement. */
export type QuotaResource =
  | "items"
  | "webhooks"
  | "blobs"
  | "storage_bytes"
  | "rate_per_minute";

/** Tenant-level configuration. Admin-writable via `/tenants/current/config`. */
export interface TenantConfig {
  retention?: Record<string, TenantRetentionOverride>;
  enforcement?: EnforcementSettings;
  /**
   * Maximum number of hops a single event may traverse before the bus
   * drops it as a suspected cycle. WS2 PR 8 — connector reactions can
   * publish further events; without a budget, a malformed integration
   * could spin a feedback loop. Default 5; admins can raise it for
   * deeply pipelined integrations or lower it to tighten the leash.
   */
  max_event_hop_budget?: number;
  /**
   * T-050: tenant-scoped retention overrides for the four cleanup jobs.
   * Each falls back to the instance env default when unset. Values must
   * be non-negative; `0` disables the job for that tenant (matches the
   * env-default semantics for `TRASH_RETENTION_DAYS=0` /
   * `FEED_RETENTION_DAYS=0`). Negative values are rejected at write.
   */
  audit_retention_days?: number;
  event_log_retention_hours?: number;
  trash_retention_days?: number;
  feed_retention_days?: number;
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
  /**
   * Lowercase alphanumeric + hyphens, 3–32 chars. Optional — users claim a
   * handle through the UX rather than at signup. Per TSC42 §8 the user-id
   * (the immutable PK) is what foreign references key off; the handle is
   * potentially renameable in a later iteration. Reserved roots and
   * reserved structural words cannot be claimed.
   */
  handle: string | null;
  created_at: string;
  updated_at: string;
}
