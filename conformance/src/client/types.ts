/** The core item — materialized current state */
export interface MarfaItem {
  id: string; // UUIDv7, server-generated
  type: string; // Type identifier: "core.note", "core.media.book", "acme.deal"
  properties: Record<string, unknown>; // Typed data validated against the type schema
  source: string | null;
  source_id: string | null;
  state: string; // Lifecycle state, such as "active", "archived", "trashed" or "revoked"
  created_at: string; // ISO 8601
  updated_at: string | null;
  occurred_at: string | null; // When the item's content happened (nullable, defaults to created_at)
  tier?: "library" | "feed"; // Items are either curated library content or transient feed content. Optional — system.* items have no tier.
  version: number; // Revision number, starts at 1, increments on update
  schema_version: number; // Type schema version this item was validated against
  capture_latitude: number | null;
  capture_longitude: number | null;
  /**
   * Hydrated relationships. Keyed by edge_type → the first page of that type.
   * Empty object `{}` when the item has no edges.
   */
  edges?: Record<string, PaginatedResult<MarfaEdge>>;
}

/** Mutable metadata sidecar — tags and extensions */
export interface MarfaMetadata {
  item_id: string;
  tags: string[];
  extensions?: Record<string, Record<string, unknown>>;
  updated_at: string | null;
}

/** Server-only snapshot of an item's properties at a point in time */
export interface MarfaVersion {
  id: string;
  item_id: string;
  version: number;
  properties: Record<string, unknown>;
  created_at: string;
}

export type EdgeCardinality =
  "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

export type EdgeCascadeBehavior = "cascade" | "orphan" | "block";

/** A typed, first-class relationship between two items. */
export interface MarfaEdge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface EdgeTypeRegistration {
  id: string;
  label?: string;
  description?: string;
  cardinality: EdgeCardinality;
  source_type_constraints?: string[];
  target_type_constraints?: string[];
  cascade_on_delete?: EdgeCascadeBehavior;
  property_schema?: Record<string, unknown>;
}

/** Full edge-type definition as returned by the server (core or custom). */
export interface EdgeTypeDefinition extends EdgeTypeRegistration {
  created_at?: string;
  updated_at?: string;
}

// Every field type the server validates against. The list is complete on
// purpose: a type missing from it is a surface the server validates and no
// fixture here can express.
export type FieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "url"
  | "email"
  | "date"
  | "datetime"
  | "enum"
  | "array"
  | "object"
  | "thumbnail";

export interface FieldDefinition {
  type: FieldType;
  /** One line of prose, carried through to the registry. */
  description?: string;
  required?: boolean;
  searchable?: boolean;
  /** Required on an `enum` field: the closed set of accepted values. */
  enum_values?: string[];
  /** Required on an `array` field: names the element type. */
  items_type?: FieldType;
  maxLength?: number;
  maxItems?: number;
  /**
   * A refinement of a string: `url`, `email`, `datetime`, `date` and
   * `thumbnail` are stored as the field type of the same name, while
   * `bcp47` and `iso3166` annotate the string and are stored as `format`.
   */
  format?: string;
}

export interface TypeSchema {
  id: string; // Type identifier: "core.note", "acme.deal"
  version?: number; // Server defaults to 1 on registration
  label?: string; // Optional human-readable display name (server auto-generates from id if omitted)
  description?: string;
  // Explicit parent in the inheritance chain. Dotted ids alone do not imply
  // inheritance — the server walks the `parent` reference to resolve
  // ancestors for field inheritance and for edge-constraint matching.
  parent?: string;
  fields: Record<string, FieldDefinition>;
  display_hints?: {
    title_field?: string;
    body_field?: string;
  };
  /**
   * Per-field merge policy a client reads to drive conflict resolution.
   * Resolved-with-inheritance form is emitted by `GET /types/:id` and embedded
   * in 409 conflict responses.
   */
  merge_policy?: MergePolicy;
  /**
   * Sibling-type compatibility declaration. When set, the type asserts a
   * structural-superset relationship with the named target — the server
   * validates at registration and rejects mismatched claims with
   * `compatible_with_violation`.
   */
  compatible_with?: string;
}

export interface SearchResult {
  item: MarfaItem;
  metadata: MarfaMetadata;
  relevance_score: number;
  snippet_html?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  next_cursor: string | null;
}

export interface ApiKeyRequest {
  label: string;
  source: string;
  type_permissions?: Record<string, string>;
  edge_permissions?: Record<string, string>;
  extension_permissions?: Record<string, string>;
  metadata_permissions?: Record<string, string>;
  /** The permissions the key holds; omitted takes the creator's when no
   *  map and no source is named either, and none when one is. */
  permissions?: readonly string[];
  default_tier?: "library" | "feed";
  /** Only an operator key can mint another, and it holds no permissions. */
  is_operator?: boolean;
  /** The sources the key may name on a write besides its own; omitted
   *  takes the creator's when no map is named either. */
  sources?: readonly string[];
}

/** The one account behind the instance's sign-in surface. */
export interface Owner {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

export interface ApiKeyResponse {
  id: string;
  key: string;
  label: string;
  source?: string;
  type_permissions: Record<string, string>;
  edge_permissions?: Record<string, string>;
  extension_permissions?: Record<string, string>;
  metadata_permissions?: Record<string, string>;
  permissions?: string[];
  default_tier?: "library" | "feed";
  is_operator?: boolean;
  sources?: string[];
  oauth_client_id?: string;
  created_at: string;
  last_used_at?: string | null;
}

export interface BlobUploadResponse {
  hash: string;
  mime_type: string;
  size_bytes: number;
}

export interface BlobStoreRow {
  id: string;
  kind: "disk" | "s3";
  locator: string;
  policy: string;
  attached_at: string;
  detached_at: string | null;
}

export interface BlobLocationRow {
  store_id: string;
  kind: "disk" | "s3";
  policy: string;
  detached: boolean;
  recorded_at: string;
  verified_at: string | null;
}

export interface BlobOrphanRow {
  hash: string;
  mime_type: string;
  size_bytes: number;
  reported_at: string;
}

export interface HousekeepingJobRow {
  name: string;
  interval_ms: number;
  next_run_at: string;
  running_since: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_outcome: "ok" | "error" | null;
  last_error: string | null;
  last_result: unknown;
}

export interface HousekeepingRun {
  name: string;
  started_at: string;
  finished_at: string;
  outcome: "ok" | "error";
  result: unknown;
  error: string | null;
}

export interface ConnectorRun {
  id: string;
  connector_id: string;
  outcome: "succeeded" | "failed";
  started_at: string;
  finished_at: string;
  summary: string | null;
  error: string | null;
  reported_at: string;
}

export interface ConnectorRunInput {
  outcome: "succeeded" | "failed";
  started_at: string;
  finished_at: string;
  summary?: string;
  error?: string;
}

export interface ConnectorRow {
  id: string;
  key_id: string;
  source: string;
  name: string;
  description: string | null;
  registered_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  last_run: ConnectorRun | null;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Per-field strategy declared on a type's `merge_policy`. */
export type MergeStrategy = "last_writer_wins" | "keep_both_copies";

/**
 * Resolved merge policy for a type. Inheritance has already been walked by the
 * server before this is emitted, so consumers can read it directly.
 */
export interface MergePolicy {
  fields?: Record<string, MergeStrategy>;
  default?: MergeStrategy;
}

/**
 * A snapshot of an item at one version, as a conflict envelope carries it.
 *
 * The three item fields ride beside the properties because the version
 * check covers them and `conflicting_fields` can name one (`versions.md`
 * 8): a client told that `tier` collided and shown neither side's value
 * has been named a reason it cannot act on.
 */
export interface ConflictSnapshot {
  /** The row the snapshot is of: the only way a create that named a natural
   *  key learns which row refused it. */
  id: string;
  version: number;
  properties: Record<string, unknown>;
  tier: "library" | "feed";
  occurred_at: string;
  source_id: string | null;
  /** The type the row had at this version, so a collision naming `type`
   *  shows both sides of the move. */
  type: string;
}

/** The 409 a stale write gets when its base version's snapshot is retained. */
export interface ConflictResponse {
  error: { code: "version_conflict"; status: 409; message: string };
  current: ConflictSnapshot;
  ancestor: ConflictSnapshot;
  conflicting_fields: string[];
  merge_policy: MergePolicy;
}

/**
 * The 409 a stale write gets when it carried nothing to merge.
 *
 * The same envelope minus the three fields that describe a merge. A client
 * reads `current.version` off this exactly as it does off the three-way
 * one, which is the whole of why it exists as a shape rather than as a bare
 * refusal.
 */
export interface StaleVersionResponse {
  error: { code: "version_conflict"; status: 409; message: string };
  current: ConflictSnapshot;
}

/** The 409 a write gets when no snapshot exists for the version it names. */
export interface AncestorUnavailableResponse {
  error: { code: "ancestor_unavailable"; status: 409; message: string };
  current: ConflictSnapshot;
  requested_version: number;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  ok: boolean;
  error?: ErrorResponse;
}

export interface BulkItemInput {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
  state?: string;
  tags?: string[];
  tier?: "library" | "feed";
  source?: string;
  source_id?: string;
  occurred_at?: string;
  /** The version this entry was based on, where it resolves a row that
   *  already exists. Optional, as on the create door. */
  version?: number;
  edges?: Record<string, string[]>;
}

export type BulkOutcome = "created" | "updated" | "skipped" | "errored";

export interface BulkResultEntry {
  index: number;
  outcome: BulkOutcome;
  id?: string;
  reason?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface BulkResponse {
  counts: {
    created: number;
    updated: number;
    skipped: number;
    errored: number;
  };
  results: BulkResultEntry[];
  blobs_imported?: number;
}

export interface BulkInput {
  items: BulkItemInput[];
  mode?: "upsert" | "create_only";
  atomic?: boolean;
  enable_fanout?: boolean;
}

export interface BulkEdgeInputItem {
  id?: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties?: Record<string, unknown>;
}

export interface BulkEdgeResultEntry {
  index: number;
  outcome: BulkOutcome;
  id?: string;
  reason?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface BulkEdgeResponse {
  counts: {
    created: number;
    updated: number;
    skipped: number;
    errored: number;
  };
  results: BulkEdgeResultEntry[];
}

export interface BulkEdgeInput {
  edges: BulkEdgeInputItem[];
  mode?: "upsert" | "create_only";
  atomic?: boolean;
  enable_fanout?: boolean;
}

export interface BulkActionFilter {
  type?: string;
  state?: string;
  source?: string;
  tier?: "library" | "feed";
  tags?: string[];
  /**
   * Lower bound on the item's own time — `occurred_at`, falling back to
   * `created_at` — exclusive.
   *
   * The bulk-action door is where a dropped bound costs rows rather than a
   * wrong answer, which makes it the typed surface most worth keeping honest.
   */
  occurred_after?: string;
  /** Upper bound on the same expression, exclusive. */
  occurred_before?: string;
  filter?: string;
}

interface BulkActionBase {
  filter?: BulkActionFilter;
  dry_run?: boolean;
  max_items?: number;
  enable_fanout?: boolean;
}

export type BulkActionInput =
  | (BulkActionBase & {
      action: "transition";
      state: "active" | "archived" | "trashed";
    })
  | (BulkActionBase & { action: "purge"; confirm?: "PURGE" })
  | (BulkActionBase & {
      action: "update_tags";
      add?: string[];
      remove?: string[];
    })
  | (BulkActionBase & { action: "update_tier"; tier: "library" | "feed" })
  | (BulkActionBase & {
      action: "update_properties";
      patch: Record<string, unknown>;
    })
  | (BulkActionBase & { action: "update_occurred_at"; occurred_at: string });

export interface BulkActionResponse {
  action: string;
  matched: number;
  succeeded: number;
  errored: number;
  dry_run: boolean;
  ids?: string[];
  errors?: { id: string; code: string; message: string }[];
  blob_hashes_referenced?: number;
}

// Async-job envelope. Returned by POST /items/bulk-actions (non-dry-run,
// status 202) and by GET /items/bulk-actions/jobs/:id. Once `status` is
// terminal, `result` carries the BulkActionResponse shape that callers
// ultimately want.
export type BulkActionJobStatus =
  "queued" | "in_progress" | "completed" | "failed" | "canceled";

export interface BulkActionJob {
  id: string;
  action: string;
  status: BulkActionJobStatus;
  matched: number;
  processed: number;
  succeeded: number;
  errored: number;
  started_at?: string;
  finished_at?: string;
  error?: string;
  result?: BulkActionResponse;
}

export interface RestoreArchiveResponse {
  imported: number;
  duplicates: number;
  edges_imported: number;
  edges_skipped: number;
  blobs_imported: number;
}

export interface PerfResult {
  name: string;
  runs: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  ops_per_sec?: number;
}

/**
 * A resource awaiting teardown, paired with the credential that created it.
 *
 * Both `DELETE /types/{id}` and `DELETE /webhooks/{id}` answer 404 to a
 * credential that cannot see the row, and 404 is the status teardown reads
 * as already gone, so a row deleted through the wrong credential reports a
 * clean cleanup and stays.
 */
export interface TrackedResource {
  id: string;
  /**
   * The client that created it. Cleanup deletes with this credential, falling
   * back to the phase's default when it is absent.
   */
  createdBy?: unknown;
  /**
   * The parent this type declared, for the type phase: a parent is refused
   * while a child still declares it, so teardown reaches the child first. The
   * declared parent is what the server answers on, not the dotted name.
   */
  parent?: string;
}

export interface TestContext {
  runId: string;
  /** `conformance-<runId>-<suite>-<file>`, the credential-stamped source. */
  source: string;
  trackedItems: string[];
  trackedKeys: string[];
  trackedEdges: string[];
  trackedEdgeTypes: string[];
  /**
   * Outbound webhook subscriptions for cleanup, each with the credential that
   * registered it. A subscription left behind keeps attempting delivery.
   */
  trackedWebhooks: TrackedResource[];
  /** Custom item types for cleanup, each with the credential that made it. */
  trackedTypes: TrackedResource[];
  client: unknown;
  /**
   * The client `cleanup` revokes keys with. Resolved from the environment
   * unless set; settable so teardown can be tested without a server.
   */
  provisioningClient?: unknown;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  type_filter?: string | null;
  /** Plaintext on creation only; redacted to its last characters afterwards. */
  secret: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  status_code: number | null;
  attempt: number;
  succeeded: boolean;
  error: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  created_at: string;
  key_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  client_ip: string | null;
  details: Record<string, unknown>;
}

export interface OccurrencesResponse {
  next_cursor: null;
  data: Array<{
    starts_at: string;
    ends_at?: string;
    item: MarfaItem;
    series_id?: string;
    replaces?: string;
  }>;
  window: { from: string; to: string };
  scan: Record<string, number>;
}
