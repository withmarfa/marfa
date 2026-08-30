// Marfa wire types — the format shared between server and clients over the API.

import type { ItemState, MergePolicy } from "@withmarfa/types";

/** Valid item states as a readonly array, useful for validation. */
export const ITEM_STATES: readonly ItemState[] = [
  "active",
  "archived",
  "trashed",
  "revoked",
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
 * Whether a value is a tier this build recognizes.
 *
 * Exists for the same reason `isMarfaRole` does, and is keyed off `TIERS`
 * rather than repeating the union literal so adding a tier cannot leave
 * this behind. Both dialects' item projections compared the column against
 * two hardcoded literals instead, which is the same defect wearing
 * different syntax: a tier added here would have been dropped to
 * `undefined` by two comparisons nobody would think to update.
 *
 * Kept free of any logging concern because this ships to npm.
 */
export function isTier(value: unknown): value is Tier {
  return (
    typeof value === "string" && (TIERS as readonly string[]).includes(value)
  );
}

/**
 * Principal roles.
 *
 * Applies to both API-key principals and OAuth-bearer principals. The role
 * gates admin-shaped routes via `requireSpaceAdmin(c)` and `requireAdmin(c)`;
 * the bearer middleware projects this onto the synthetic principal regardless
 * of credential type.
 *
 * - `admin` — platform admin (full instance authority). Bypasses every
 *   permission map. Used for system config, cross-space ops, minting platform
 *   credentials.
 * - `space_admin` — space-bounded admin. Full admin authority within the
 *   calling principal's `space_id`: own keys, webhooks, types, connections,
 *   extensions. Cannot cross-space read/write (RLS-enforced), cannot mint
 *   platform credentials, cannot touch system config.
 * - `member` — non-admin credential. Bound by `type_permissions` /
 *   `edge_permissions` / `extension_permissions` / `metadata_permissions`.
 */
export type MarfaRole = "admin" | "space_admin" | "member";

/** Valid role values as a readonly array, in descending authority order. */
export const MARFA_ROLES: readonly MarfaRole[] = [
  "admin",
  "space_admin",
  "member",
] as const;

/**
 * Whether a value is one of the roles this build recognizes.
 *
 * Exists because a role read back from storage is a bare string, and every
 * gate that consumes one compares it against a literal. A value outside the
 * union therefore matches no branch and is not refused anywhere, it simply
 * fails every comparison, which reads as "not an admin" in one place and,
 * where the comparison runs through `ROLE_RANK`, as `undefined < 2` and so
 * "not below space_admin" in another. One stale value produced both, in
 * opposite directions, and neither said anything.
 *
 * Keyed off `MARFA_ROLES` rather than a repeated union literal so adding a
 * role cannot leave this behind.
 */
export function isMarfaRole(value: unknown): value is MarfaRole {
  return (
    typeof value === "string" &&
    (MARFA_ROLES as readonly string[]).includes(value)
  );
}

/**
 * Narrows an untrusted role to the union, falling back rather than throwing.
 *
 * Deliberately does not translate historical values forward. A rename is
 * finished by the migration that realigns the stored rows; a translation
 * table in live code would keep a retired word working indefinitely and
 * hide the fact that a database was never migrated.
 *
 * Falls back because the callers are row projections. A parse that threw
 * would take out every list query touching one bad row, turning a single
 * mis-migrated record into an outage. Callers that can report the value
 * should do so, see `storage/stored-role.ts` in the server, which pairs
 * this with a log line so a fallback is visible rather than silent.
 */
export function parseMarfaRole(
  value: unknown,
  fallback: MarfaRole = "member",
): MarfaRole {
  return isMarfaRole(value) ? value : fallback;
}

/**
 * Authority ranking of the roles. Higher outranks lower.
 *
 * The ordering was always implicit in the prose above and in the order
 * `MARFA_ROLES` is declared; naming it makes "is this role above that one"
 * a decidable question instead of a judgement call at each callsite.
 *
 * Rank is the ONLY axis this encodes. Two capabilities sit orthogonal to
 * it and are gated separately: `is_platform` (writes to the reserved
 * `system.*` / `marfa.*` namespaces) and space binding (a credential
 * carrying a `space_id` is confined to that space whatever its rank).
 */
export const ROLE_RANK: Readonly<Record<MarfaRole, number>> = {
  admin: 3,
  space_admin: 2,
  member: 1,
};

/**
 * Whether a principal holding `granter` may mint a credential carrying
 * `granted`.
 *
 * Privilege can be passed sideways or downwards, never upwards: a
 * credential must not be able to manufacture more authority than the
 * caller presenting it already holds. Callers combine this with the
 * orthogonal gates — granting `is_platform` additionally requires the
 * caller to be platform itself, and a minted credential inherits the
 * caller's space binding.
 */
export function canGrantRole(granter: MarfaRole, granted: MarfaRole): boolean {
  return ROLE_RANK[granted] <= ROLE_RANK[granter];
}

/** Per-type permission levels. */
export type TypePermission = "read" | "write" | "none";

/** Per-namespace extension permission levels. */
export type ExtensionPermission = "read" | "write";

/** A Marfa item — the fundamental data record. */
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
   * Space scope. Optional because storage queries are space-scoped at
   * the SQL layer (`spaceWhere` enforces a `WHERE space_id = ?` on every
   * read), so for ordinary callers `space_id` always matches the caller's
   * own space and the field is informational. The reactive-run bridge reads
   * this to gate fanout on space match. Mirrors `Edge.space_id`.
   */
  space_id?: string | null;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  timestamp: string;
  source: string;
  source_id?: string;
  version: number;
  schema_version: number;
  device?: string;
  capture_latitude?: number;
  capture_longitude?: number;
  /**
   * Whether the integration named in `source` still has a live connection in
   * this item's space.
   *
   * **Derived per read and never stored.** No column backs it, no write
   * accepts it, and the storage layer never sets it — it is attached by the
   * server as an item goes out, from the connections the space holds at that
   * moment. It lives on `Item` rather than beside it because `Item` is the
   * shape a client receives, and a field a typed client cannot see without a
   * cast is only half a signal.
   *
   * **Absent means the question does not apply**, not "no". Only an item an
   * integration wrote carries it: a hand-written note has no upstream to be
   * cut off from and can never acquire one. `false` says the integration is
   * still installed there; `true` says it is not, and the item is a copy of
   * a record nothing is keeping current any more.
   *
   * **Every REST response that carries an item answers**, whether it read
   * the row or just wrote it — so a `POST /items` or `PATCH` response omits
   * it for exactly the same reason a `GET` does, and never because a write
   * had no chance to look.
   *
   * **The one surface that does not is the `GET /events` stream.** Removing
   * a connection publishes no item events, so the stream cannot report the
   * change this field describes, and its frames leave the field off
   * entirely. A client merging frames over a read must keep the value the
   * read gave it rather than reading absence in a frame as an answer, and
   * must re-read to refresh it.
   */
  orphaned?: boolean;
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
  device?: string;
  capture_latitude?: number;
  capture_longitude?: number;
  tags?: string[];
}

/** Input for updating an existing item. */
export interface UpdateItemInput {
  properties?: Record<string, unknown>;
  /**
   * Faithful-mirror semantics for an owning integration's re-sync: an
   * explicit null deletes the key instead of reading as "leave unset".
   * The upstream cleared the field, so the mirror must clear it too —
   * otherwise a stale value survives every re-sync. Set by the server
   * for owner writes to integration-owned rows; never caller-supplied.
   */
  null_clears?: boolean;
  version?: number;
  /** Force a version snapshot for this update, bypassing the
   *  snapshot-interval throttle in version gating. */
  force_snapshot?: boolean;
  /** Toggle the tier (`library` ↔ `feed`). Independent of the version-merge
   *  path for `properties`; flipping `tier` doesn't conflict (it's a single
   *  metadata-axis flag, last-writer-wins by design). */
  tier?: Tier;
  /** Override the user-meaningful timestamp. Settable on create; this
   *  field lets importers fix dates retroactively without rewriting
   *  properties. Independent of the version-merge path. */
  timestamp?: string;
  /**
   * Repoint the item at a new natural-key identifier under the caller's
   * stamped `source`. The `(source, source_id)` tuple is unique per space
   * — the same constraint enforced at create time — so the server rejects
   * the update with HTTP 409 `source_id_conflict` if the target value is
   * already taken by a different item. PATCHing the same value the item
   * already carries is a no-op success. Used by the sync agent to preserve
   * item identity through file renames without losing the path-derived
   * natural key.
   */
  source_id?: string;
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

/**
 * A typed edge between two items. Direction: source is "from", target is "to".
 * See `packages/types/core/edges/*.json` for semantics per edge type.
 */
export interface Edge {
  id: string;
  space_id?: string | null;
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
 * (e.g. space config) follow the same shape. Default `{}` — no access —
 * means non-admin/non-platform credentials cannot mutate the metadata
 * surface.
 */
export type MetadataPermission = "read" | "write";

/**
 * A level on Category 2, Your profile. Levelled in the same sense as
 * metadata: read is a level rather than a free baseline, because the
 * category holds a person's name, email address and avatar.
 */
export type ProfilePermission = "read" | "write";

/** An API key record (without the key value itself). */
export interface ApiKey {
  id: string;
  space_id?: string;
  label: string;
  /** Human-readable display name stamped onto items this credential writes. */
  source: string;
  /**
   * Stable item-provenance source. Runtime credentials rotate frequently,
   * so their credential `source` identifies one bearer generation while
   * `item_source` stays fixed for the bound Connection. Item writes stamp
   * this value when present, preserving `(source, source_id)` idempotency
   * across credential refreshes. Ordinary keys leave it unset and continue
   * stamping `source`.
   */
  item_source?: string;
  role: MarfaRole;
  /**
   * Platform-credential gate. When `true`, the credential may write items
   * of the reserved-namespace types (`core.*`, `system.*`, `marfa.*`) and
   * is exempt from the publisher-handle ownership rule at type
   * registration. It does not admit reserved-namespace registration:
   * `POST /types` refuses a reserved-root type for every credential,
   * platform included — those types arrive with the build. The first
   * credential created at server install is the seed platform credential;
   * only an existing platform credential may mint another. Defaults to
   * `false` for ordinary space admin and member keys.
   */
  is_platform: boolean;
  /**
   * Scope-enforcement gate. When `true`, this credential is limited to
   * exactly the scopes it was granted on the data plane — the
   * `admin` / `space_admin` role bypass in `checkTypeAccess`,
   * `computeTypeFilter`, `requireEdgePermission`, and
   * `requireMetadataPermission` does NOT apply. Set on OAuth-derived
   * synthetic keys: a user's role is the ceiling on what an app can be
   * granted, not an automatic full-access pass for every app the user
   * signs into. Ordinary API keys leave this unset and keep the role
   * bypass. Role gates (`requireSpaceAdmin` / `requireAdmin`) still read
   * the projected role regardless of this flag.
   */
  scope_enforced?: boolean;
  /**
   * Connections runtime credential gate. When `true`, the credential was
   * minted by the integration runtime for a specific Connection's
   * dispatch. The extension write gate narrows such credentials to
   * writing only the `connection.runtime` subtree of the item whose id
   * matches `connection_id`.
   *
   * Defaults to `false` for every other credential type. The runtime's
   * own mint path is the only one that flips this flag; ordinary key
   * creation cannot.
   */
  is_runtime_credential?: boolean;
  /**
   * Set when `is_runtime_credential` is `true`. Stamps the Connection
   * the credential was minted for. The extension gate compares this
   * against the path `:id` for cross-space denial.
   */
  connection_id?: string;
  /**
   * Per-credential schema-enforcement override. Same shape as
   * `SpaceConfig.enforcement`; entries here merge over the space default
   * for this credential's writes/reads. Optional — most credentials inherit
   * space config without override.
   */
  enforcement_override?: EnforcementSettings;
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
  /**
   * Category 2, Your profile. Keyed on the row (`name`, `email`, `avatar`)
   * with the levelled parent keyed on `*`.
   *
   * Absent means the caller holds nothing on this category, which on a
   * levelled category means it may not read it either. A first-party key
   * bypasses the map through its role, exactly as it does for metadata; an
   * OAuth token is `scope_enforced` and does not.
   */
  profile_permissions?: Record<string, ProfilePermission>;
  created_at: string;
  /**
   * Hard lifetime bound (ISO timestamp). A key past its `expires_at` is
   * refused at the bearer gate exactly like a revoked key. `null` (or
   * absent) means the key never expires — the shape of every human-minted
   * key. Runtime credentials are always stamped at mint so the retention
   * reaper can retire them without an explicit revoke.
   */
  expires_at?: string | null;
  last_used_at: string | null;
}

/** Input for creating a new API key. */
export interface CreateKeyInput {
  label: string;
  source: string;
  role: MarfaRole;
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
 * Input for `POST /admin/spaces/{id}/keys`, the platform-admin route that
 * mints a key into a named space rather than into the caller's own.
 *
 * Two deliberate differences from {@link CreateKeyInput}: the space comes
 * from the path, not the body; and there is no `is_platform`, because the
 * whole point of the route is a credential whose authority is confined to
 * one space. `role` defaults to `member` server-side.
 */
export interface CreateSpaceKeyInput {
  label: string;
  source: string;
  role?: MarfaRole;
  default_tier?: Tier;
  type_permissions?: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  edge_permissions?: Record<string, EdgePermission>;
  metadata_permissions?: Record<string, MetadataPermission>;
}

/**
 * Input for in-place updating an API key (PATCH). All fields optional;
 * `source` and `role` are intentionally omitted — they are immutable after
 * creation (source is baked into item provenance, role is security-critical).
 */
export interface UpdateKeyInput {
  label?: string;
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
 * The durable grant record lives on a `system.connection` item (kind: app).
 * The `id` field is the underlying item id; subsequent OAuth records (codes,
 * tokens) reference it as `connection_item_id`.
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
  "pending" | "approved" | "denied" | "expired";

// ---------------------------------------------------------------------------
// Webhook types
// ---------------------------------------------------------------------------

/** A registered outbound webhook. */
export interface Webhook {
  id: string;
  space_id?: string;
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
  succeeded: boolean;
  error: string | null;
  created_at: string;
}

/**
 * An inbound webhook subscription. Receives POST requests from external
 * services at `POST /webhooks/inbound/:id`. Each subscription belongs to a
 * `system.connection` of kind `integration` and stamps its verification
 * method (read from the Integration manifest) at creation time. The raw
 * shared secret is returned only in the create response; subsequent reads
 * always redact it.
 */
export interface InboundWebhook {
  id: string;
  space_id?: string;
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
   * Always undefined on new rows — the `custom` verification method is
   * no longer supported. The column is retained for data compatibility
   * and will be removed in a follow-on migration.
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
  /** Subscribed event types — opaque strings the integration understands. */
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
  /** NULL until the reactive runner finishes processing. */
  processed_at: string | null;
  /** NULL until retries are exhausted (DLQ). */
  processing_error: string | null;
  retry_count: number;
  next_attempt_at: string | null;
}

/**
 * Wire view of a leased bearer token issued to an integration for cases the
 * OAuth proxy doesn't cover (multipart streaming, WebSocket, SDK lock-in,
 * non-HTTP). The lease IS a bearer token; storage is hashed (SHA-256) like
 * API keys, and the plaintext is returned exactly once on issue.
 */
export interface ConnectionLeasedToken {
  id: string;
  connection_id: string;
  space_id: string | null;
  capability_id: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/**
 * Extends `ConnectionLeasedToken` with the raw `lease_token` field —
 * returned once in the 201 response to `POST /connections/:id/lease-tokens`,
 * never echoed by subsequent reads.
 */
export interface CreatedConnectionLeasedToken extends ConnectionLeasedToken {
  /** Plaintext bearer; pass to validate / use against the upstream. */
  lease_token: string;
}

/**
 * Wire shape accepted by `POST /connections/install`. The JSON install
 * sibling of the HTML consent flow — skips the human-consent step (no
 * browser approval) and is admin-only.
 */
export interface ConnectionInstallInput {
  /** id of the `system.integration` item (a manifest registered via
   *  `POST /integrations`) the new connection binds to. */
  integration_id: string;
  /** Optional id of an existing `system.credential` (kind `oauth_token` or
   *  `api_token`) to reference instead of provisioning a fresh provider
   *  credential. Lets multiple integrations of the same upstream (e.g.
   *  `google/calendar` + `google/tasks`) share one credential instead of
   *  duplicating per-integration. Create such credentials via
   *  `POST /credentials/oauth-provider` or `POST /credentials/api-token`. */
  credential_ref?: string;
  /** Optional seed for the new connection's `properties.configuration`
   *  bag. Free-form per-integration knobs (e.g. `upstream_base_url_override`
   *  for connections sharing one credential across different upstream
   *  hosts). Merged over the empty default at install time so callers
   *  don't need a follow-on `PATCH /items/:id` round-trip. */
  configuration?: Record<string, unknown>;
}

/**
 * Wire shape returned by `POST /connections/install`: the connection id
 * and the `system.activity` row id from the install pipeline.
 */
export interface ConnectionInstallResult {
  connection_id: string;
  /** id of the system.activity row emitted by the pipeline. */
  activity_id: string;
}

/**
 * Result of pausing or resuming an `integration` connection.
 *
 * `runtime_status` is the field that carries the answer: the
 * `system.connection` lifecycle is bounded to `active | revoked`, so
 * there is no paused *state* to move to, and `runtime_status` already
 * has a `paused` member for exactly this.
 */
export interface ConnectionRuntimeStateResult {
  connection_id: string;
  runtime_status: "paused" | "healthy";
  /** id of the system.activity row emitted by the pipeline. */
  activity_id: string;
}

/**
 * Wire shape returned by `POST /connections/:id/uninstall`. Records the
 * artifacts the orchestrated uninstall pipeline cleaned up — the runtime
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
 * Item-event types the reactive bridge fans out to integrations.
 * Mirrors the `ItemEvent['type']` union in `packages/server/
 * src/pubsub.ts`. Used by `POST /connections/preview-event` for the
 * operator-supplied `event_type` in the preview-event request.
 */
export type PreviewEventItemEventType =
  | "created"
  | "updated"
  | "deleted"
  | "restored"
  | "state_changed"
  | "metadata_changed";

/**
 * Optional cycle metadata an operator can override on a preview-event
 * request. Maps to the cycle-detection fields stamped server-side at
 * `pubsub.publish` time (`originatingConnectionId`, `hopCount`). Default
 * values — `originating_connection_id: null`, `hop_count: 0` — describe
 * a human-originated event that always passes the per-space hop budget.
 *
 * Set both fields to model a reactive event mid-chain ("what would happen
 * if connection X re-published this at hop 4?").
 */
export interface PreviewEventCycleOverride {
  originating_connection_id?: string | null;
  hop_count?: number;
}

/**
 * Wire shape for `POST /connections/preview-event`. Operator supplies an
 * existing item id plus an event type; the route renders the
 * `QueueMessageBody` envelopes the reactive-run bridge would emit, and for
 * each subscribing connection that wouldn't be dispatched, the reason why.
 * Pure server-side transform — no handler invocation, no queue producer call.
 * Space-admin scoped.
 */
export interface PreviewEventRequest {
  /** id of an existing item the operator wants to simulate fanout for. */
  item_id: string;
  /** Item-event type to simulate. */
  event_type: PreviewEventItemEventType;
  /**
   * Optional filter to a single subscribing connection id. Default behavior
   * (omitted) renders all subscribers in the caller's space.
   */
  connection_id?: string;
  /**
   * Optional override for the cycle-detection metadata stamped on the
   * synthetic event. Defaults to a human-originated shape that passes the
   * hop budget. Useful for reproducing "what if hop_count was N?"
   * scenarios.
   */
  cycle?: PreviewEventCycleOverride;
}

/**
 * One row in the preview response — the bridge's verdict for one
 * (event, subscriber) pair.
 *
 * `dispatch_reason` values:
 *   - `ok`: would dispatch; `envelope` is populated.
 *   - `self_event`: subscriber is the connection that originated the event.
 *   - `cross_space`: subscriber's space doesn't match the event's space.
 *   - `type_not_targeted`: the item's type is not in the subscriber
 *     manifest's `target_types` — its runtime credential could not read
 *     the item, so the dispatch could only fail.
 *   - `hop_budget_exceeded`: per-space `max_event_hop_budget` would
 *     refuse to publish the event upstream of the bridge — applies to
 *     every subscriber when the gate trips.
 *   - `subscription_inactive`: the operator filtered to a connection id
 *     that isn't currently a subscriber (revoked, wrong kind, manifest
 *     missing an `item-event` trigger, etc.).
 *   - `subscription_paused`: the filtered connection is paused — the
 *     one inactive cause an operator flips on purpose; resume restores
 *     dispatch.
 */
export interface PreviewEventEnvelope {
  connection_id: string;
  /** Manifest name from the connection's bound integration; "" when the
   *  connection is not a subscriber (`subscription_inactive` /
   *  `subscription_paused`). */
  integration_name: string;
  would_dispatch: boolean;
  dispatch_reason:
    | "ok"
    | "self_event"
    | "cross_space"
    /** The event is a `system.*` row — the platform's own bookkeeping,
     *  which never fans out to reactive handlers. */
    | "system_type"
    | "type_not_targeted"
    | "hop_budget_exceeded"
    | "subscription_inactive"
    | "subscription_paused";
  /**
   * The wire envelope the bridge would enqueue for dispatch, present
   * iff `would_dispatch === true`. Mirrors the bridge's internal
   * `QueueMessageBody`.
   */
  envelope?: PreviewEventQueueBody;
}

/**
 * Mirror of the reactive-run bridge's `QueueMessageBody`. Surfaced
 * publicly only via the preview-event route so operators (and the SDK)
 * can read what the bridge would have emitted without invoking handlers.
 */
export interface PreviewEventQueueBody {
  kind: "item-event";
  integration_name: string;
  connection_id: string;
  space_id?: string;
  /** Wire form, e.g. `item.created`, `item.metadata_changed`. */
  event_type: string;
  item_id: string;
  cycle: {
    originating_connection_id: string | null;
    hop_count: number;
  };
  payload: unknown;
}

/**
 * Wire shape returned by `POST /connections/preview-event`. The
 * `envelopes` array is one entry per subscribing connection (or one per
 * filtered-to connection); `hop_budget` reports the space-resolved
 * budget alongside what was used by the previewed event so the operator
 * can see how close to the cap they are.
 */
export interface PreviewEventResult {
  envelopes: PreviewEventEnvelope[];
  hop_budget: {
    /** Space-resolved `max_event_hop_budget` (default 5). */
    max: number;
    /**
     * Hop-count the synthetic event would carry under the `cycle`
     * override (default 0). Useful alongside `max` to see whether the
     * event would have been dropped before reaching the bridge.
     */
    used: number;
  };
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
 * Wire view of a stored OAuth token for an external-service integration.
 * Tokens are encrypted at rest server-side; the wire view reveals only the
 * metadata necessary for admin/observability surfaces. The `access_token`
 * and `refresh_token` fields are intentionally absent — there is no API
 * that returns them in plaintext. The proxy route is the only path through
 * which the access token influences a request, and that path forwards to
 * the upstream rather than echoing to the caller.
 */
export interface ConnectionOAuthToken {
  id: string;
  connection_id: string;
  space_id: string | null;
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

/** A space represents an isolated data namespace. */
export interface Space {
  id: string;
  name: string | null;
  created_at: string;
  /**
   * Operator-controlled lifecycle. `'active'` (default) allows writes;
   * `'suspended'` blocks them at the auth middleware. Reads pass through
   * regardless. Platform-admin keys bypass the gate so operators can inspect
   * a suspended space.
   */
  status: SpaceStatus;
}

/**
 * Valid space statuses, and the source the union is derived from.
 *
 * Declared as a tuple with `SpaceStatus` derived from it rather than the
 * other way round, so a status added to one cannot go missing from the
 * other. The same drift is what let a family be added to a union without
 * reaching the array that decides which set it joins.
 */
export const SPACE_STATUSES = ["active", "suspended"] as const;

export type SpaceStatus = (typeof SPACE_STATUSES)[number];

/**
 * Whether a value is a space status this build recognizes.
 *
 * Exists for the same reason `isMarfaRole` does. A status read back from
 * storage is a bare string, the column carries no constraint in either
 * dialect, and the one gate that consumes it compares against a single
 * literal. So a value outside the union matches no branch and is refused
 * nowhere: it reads as "not suspended", and the writes the suspension
 * exists to stop are accepted.
 *
 * Kept free of any logging concern because this ships to npm and the SDK
 * consumes it. The policy for meeting a bad value lives server-side in
 * `storedSpaceStatus`.
 */
export function isSpaceStatus(value: unknown): value is SpaceStatus {
  return (
    typeof value === "string" &&
    (SPACE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Valid account deletion states, and the source the union is derived from.
 *
 * Declared as a tuple with `DeletionState` derived from it for the reason
 * `SPACE_STATUSES` gives one block up: so a state added to one cannot go
 * missing from the other. It was previously a bare type alias written out
 * twice, once in each dialect's account-lifecycle store, which is the
 * shape that drift starts from — two declarations of one union with
 * nothing making them agree, and nothing at all to check a stored value
 * against.
 *
 * `pending_deletion` is the state the sign-in guard intercepts on, so a
 * value outside this union is not cosmetic: it matches neither branch, and
 * an account the operator believes is scheduled for deletion is simply
 * not.
 */
export const DELETION_STATES = ["active", "pending_deletion"] as const;

export type DeletionState = (typeof DELETION_STATES)[number];

/**
 * Per-space metrics snapshot. Returned by `GET /admin/spaces/:id/metrics`
 * for the named space. Same shape as the instance-wide `/metrics` endpoint,
 * scoped to one space.
 */
export interface SpaceMetrics {
  space_id: string;
  items: {
    total: number;
    active: number;
    archived: number;
    trashed: number;
  };
  blobs: {
    count: number;
    total_size: number;
  };
  /**
   * Best-effort recent activity. Last `system.activity` rows for the
   * space, newest-first, capped at the route's `limit` (default 10).
   * Empty array when the space has no activity rows.
   */
  recent_activity: SpaceActivityEntry[];
  generated_at: string;
}

export interface SpaceActivityEntry {
  id: string;
  severity: string;
  summary: string;
  created_at: string;
}

/**
 * Schema-enforcement levers. All three default off; flip on per-type to
 * tighten validation. Applied space-wide by default; per-credential override
 * available via `ApiKey.enforcement_override`.
 *
 * - `strict_mode.types` — type IDs where unknown properties are rejected on
 *   write (strict object validation).
 * - `source_allowlist` — for the listed types, only items written from one of
 *   `sources` are accepted; everything else is rejected.
 * - `source_filter` — for the listed types, reads return only items whose
 *   source matches `sources`. Filter-only, not enforcement-on-write.
 */
export interface EnforcementSettings {
  strict_mode?: { types: string[] };
  source_allowlist?: { types: string[]; sources: string[] };
  source_filter?: { types: string[]; sources: string[] };
}

/**
 * Per-space resource quotas. Empty / missing limits fall back to the
 * instance defaults from env (`MARFA_DEFAULT_QUOTA_*`). Quotas are
 * platform-admin-managed via `GET/PUT /admin/spaces/:id/quotas`; space-own
 * reads land via `GET /spaces/me/quotas` (space_admin or admin). Counts are
 * computed on-demand from existing tables at quota-check time.
 */
export interface SpaceQuota {
  space_id: string;
  items_limit?: number | null;
  webhooks_limit?: number | null;
  blobs_limit?: number | null;
  /** Storage bytes ceiling. Optional — counter + reconcile job to be
   *  added in a follow-on. */
  storage_bytes_limit?: number | null;
  /** Per-space request-rate ceiling (additional to the per-credential
   *  global rate limit). Not currently enforced. */
  rate_per_minute_limit?: number | null;
  updated_at: string;
}

/** Resource categories tracked for quota enforcement. */
export type QuotaResource =
  "items" | "webhooks" | "blobs" | "storage_bytes" | "rate_per_minute";

/** Space-level configuration. Admin-writable via `/spaces/me/config`. */
export interface SpaceConfig {
  enforcement?: EnforcementSettings;
  /**
   * Maximum number of hops a single event may traverse before the bus
   * drops it as a suspected cycle. Integration reactions can publish further
   * events; without a budget, a malformed integration could spin a feedback
   * loop. Default 5; admins can raise it for deeply pipelined integrations
   * or lower it to tighten the leash.
   */
  max_event_hop_budget?: number;
  /**
   * Space-scoped retention overrides for the cleanup jobs. Each falls back
   * to the instance env default when unset. Values must be non-negative; `0`
   * disables the job for that space. Negative values are rejected at write.
   */
  audit_retention_days?: number;
  event_log_retention_hours?: number;
  trash_retention_days?: number;
  /**
   * Days to keep `system.activity` rows. An integration reports its runs
   * as activity, so on a busy space this is the fastest-growing item
   * type by a wide margin and nothing aged it out before this existed.
   */
  activity_retention_days?: number;
}

/**
 * A user account (hosted mode). Owns exactly one space.
 *
 * The canonical email + display image lives on `auth_user`. The `email`
 * and `avatar_url` columns are not on `users` — every read of email goes
 * through `auth_user_id` → `auth_user.email`. The avatar is content-addressed
 * via `avatar_blob_hash`; the public URL is reconstructed at read time and
 * the placeholder is generated server-side from `handle`.
 *
 * The wire shape returned by the profile endpoints is `Profile`, not `User` —
 * `Profile` is the read-time projection that joins `auth_user` for email and
 * reconstructs `avatar_url`. `User` is the underlying storage shape.
 */
export interface User {
  id: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  bio: string | null;
  /** Content-addressed blob hash (`sha256:<hex>`) for the avatar. NULL
   *  means "no custom avatar"; the placeholder is rendered from the
   *  handle. Wire URL is reconstructed by the profile endpoint. */
  avatar_blob_hash: string | null;
  provider: string;
  provider_id: string;
  space_id: string;
  /**
   * Lowercase alphanumeric + hyphens, 3–32 chars. Required at signup
   * (nullable here because not every stored row carries one). The user id
   * (the immutable PK) is what foreign references key off; the handle is
   * potentially renameable. Reserved roots cannot be claimed.
   */
  handle: string | null;
  /** FK to `auth_user.id`. Canonical bridge from authentication identity
   *  to Marfa profile. NULL only on a `users` row with no matching
   *  `auth_user`. */
  auth_user_id: string | null;
  /** Principal role projected onto the bearer principal for OAuth-
   *  authenticated requests. Defaults to `member`; operator elevates
   *  via SQL. Gates admin-shaped routes (`requireSpaceAdmin`,
   *  `requireAdmin`) whether the request arrives via API key or OAuth
   *  bearer. */
  role: MarfaRole;
  /** IANA zone the account keeps its own clock in, or NULL when unstated.
   *  A default and a display preference: it is what answers "what is on
   *  today" for a caller that names no zone. It never anchors a
   *  recurrence — a series expands in its own `timezone`, so an account
   *  moving country does not reschedule its calendar. */
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Wire shape returned by the profile endpoints (`GET /profile/me`). The
 * profile's own fields are served by joining `users` to `auth_user` for the
 * canonical email, not read from an item. Avatar URL is reconstructed at
 * read time (either `/blobs/<hash>` for an uploaded avatar or
 * `/profile/placeholder/<username>.svg` when unset). Apps compose any
 * display name from `first_name` / `last_name` / `username` — there is no
 * `display_name` field by design.
 *
 * `account_holder_item_id` is the one link into the item graph: the id of
 * the `system.account_holder` row an edge can target. The fields above it
 * are still not stored there.
 */
export interface Profile {
  /** Same as `users.handle`. Required (the API rejects users without
   *  one); only nullable here for migration-in-flight rows. */
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  bio: string | null;
  /** Reconstructed at read time. Always a string (placeholder URL when
   *  no upload). */
  avatar_url: string;
  /** Mirrored read-only from `auth_user.email`. */
  email: string;
  /** Mirrored read-only from `auth_user.email_verified`. */
  email_verified: boolean;
  created_at: string;
  updated_at: string;
  /**
   * Id of the account holder's `system.account_holder` item — the graph
   * handle to aim an `authored-by` (or any other) edge at, so a client never
   * has to guess or invent a stand-in. Read-only and absent only on an
   * instance whose backfill has not run.
   */
  account_holder_item_id?: string;
}

/** `PATCH /profile/me` body. Every field is optional; `null` clears the
 *  column (where applicable). `username` runs through the reserved-handle
 *  and collision validators server-side. */
export interface UpdateProfileInput {
  username?: string;
  first_name?: string | null;
  last_name?: string | null;
  bio?: string | null;
}
