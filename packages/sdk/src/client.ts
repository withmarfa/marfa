import type {
  Item,
  ItemWithMetadata,
  CreateItemInput,
  Metadata,
  Version,
  ApiKey,
  CreateKeyInput,
  UpdateKeyInput,
  PaginatedResult,
  SearchResult,
  ItemState,
  Tier,
  InstanceConfig,
  InstanceConfigResponse,
  Edge,
  CreateEdgeInput,
  EdgeTypeSchema,
} from "@withmarfa/shared";
import type {
  TypeSchema,
  ErrorResponse,
  Webhook,
  WebhookDelivery,
  CreateWebhookInput,
  UpdateWebhookInput,
} from "@withmarfa/shared";
import { generateId } from "@withmarfa/shared";
import { HttpTransport, type TokenProviderLike } from "./transport.js";
import {
  BulkJobCanceledError,
  BulkJobFailedError,
  EdgeConflictError,
  MarfaError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
} from "./errors.js";
import {
  handleConflictUpdate,
  type ConflictStrategy,
  type ConflictResolver,
  type ConflictAutoMergeListener,
} from "./conflict.js";
import { pollUntilTerminal } from "./poll.js";
import { paginate } from "./pagination.js";
import { path } from "./path.js";
import {
  subscribeToEvents,
  type SubscribeOptions,
  type Subscription,
} from "./events.js";

// ---------------------------------------------------------------------------
// Config and option types
// ---------------------------------------------------------------------------

/**
 * Credentials are mutually exclusive at the type level: pass either a
 * static API key (marfa_k1_*) or an OAuth token provider (marfa_at_*).
 */
export type ClientCredential =
  | { apiKey: string; tokenProvider?: never }
  | { tokenProvider: TokenProviderLike; apiKey?: never };

export type ClientConfig = ClientCredential & {
  url: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Default conflict resolution strategy for all updates.
   * Can be overridden per-call via `UpdateOptions.conflict`.
   * Defaults to `"auto"` — non-conflicting fields merge, conflicting fields
   * use the server's value.
   */
  conflictStrategy?: ConflictStrategy;
  /**
   * Default listener invoked after the auto-merge path completes successfully.
   * Receives a `ConflictAutoMergedEvent` describing the per-field outcome and
   * any spawned conflicted-copy id. Per-call overridable via
   * `UpdateOptions.onAutoMerge`.
   */
  onConflictAutoMerge?: ConflictAutoMergeListener;
  timeoutMs?: number;
};

export interface UpdateOptions {
  /**
   * Version the caller expects the item to currently be at. When provided,
   * the SDK skips the upfront `GET /items/:id` and PATCHes directly. If the
   * server's actual version differs, the update 409s through the usual
   * conflict path — the caller's retry policy is out of scope here.
   *
   * Prefer `expectedVersion` for bulk importers and sync loops that already
   * know the version locally; one request instead of two.
   */
  expectedVersion?: number;
  /**
   * Override the client's default conflict strategy for this update.
   * - `"auto"`: auto-merge non-conflicting fields (default)
   * - `"manual"`: throw `ConflictError` with both versions
   * - `"callback"`: call the `resolve` function to handle the conflict
   */
  conflict?: ConflictStrategy;
  /** Custom conflict resolver (required when `conflict` is `"callback"`). */
  resolve?: ConflictResolver;
  /**
   * Key this update so a repeat of it is the same write.
   *
   * Sent as `Idempotency-Key`, and it does more here than on a create. The
   * server derives a `keep_both_copies` sibling's id from it, so an update
   * whose answer was lost replays into the *same* sibling instead of
   * spawning a second copy of the text that lost.
   *
   * Sent on the first attempt only. A `callback` strategy re-sends a body
   * its resolver produced, and a second body under one key would be
   * answered with the first body's result; `auto` and `manual` make one
   * request, so for them it covers everything.
   */
  idempotencyKey?: string;
  /** Toggle the tier (`library` ↔ `feed`). Independent of the version-merge
   *  path for `properties`; a tier-only update never conflicts. */
  tier?: Tier;
  /**
   * Repoint the item at a new natural-key identifier under the caller's
   * stamped `source`. The server enforces `(source, source_id)` uniqueness
   * — a collision returns HTTP 409 `source_id_conflict`. PATCHing
   * the value the item already carries is a no-op success. A device uses
   * it to preserve item identity through file renames.
   */
  source_id?: string;
  /**
   * Listener invoked after the auto-merge path completes successfully.
   * Overrides the client's default `onConflictAutoMerge` for this call.
   */
  onAutoMerge?: ConflictAutoMergeListener;
}

export interface ListFilters {
  type?: string;
  /** Lifecycle state. Omitting the field answers the active state, which
   *  is what a reader is working with. `"any"` widens the listing to every
   *  state, which a resuming client needs in order to see a row leave the
   *  active state. */
  state?: ItemState | "any";
  source?: string;
  /** Tier filter. `"library"` restricts to library items; `"feed"` restricts
   * to feed items; `"all"` (or omitting the field) returns both. */
  tier?: Tier | "all";
  tags?: string[];
  /** Filter-language expression, e.g. `edge[parent-of] eq "<id>"` or
   *  `edge[parent-of] not_exists`. The filter language is how edge and
   *  hierarchy relationships are queried. */
  filter?: string;
  /**
   * Sort key. Either a system column (`created_at` | `updated_at` |
   * `occurred_at`) or a naturally-orderable custom field via
   * `properties.<field>` (e.g. `properties.due_at`). Property sorts order
   * datetimes and strings lexically and numbers numerically, with absent
   * values last. Enum-semantic fields (status, priority) are deliberately not
   * sortable here — their order isn't lexical, so sort those client-side.
   */
  sort?: "created_at" | "updated_at" | "occurred_at" | `properties.${string}`;
  direction?: "asc" | "desc";
  /** Exclusive lower bound on the item's own time — `occurred_at`,
   *  falling back to `created_at`. Named for the field it reads: it says
   *  nothing about when the row last changed, which is `updated_after`. */
  occurred_after?: string;
  /** Exclusive upper bound on the same field. */
  occurred_before?: string;
  /**
   * Inclusive lower bound on `updated_at`, when the row last changed.
   *
   * The catch-up filter: hand it the cursor you hold and get back
   * everything that has changed since. Orders by `(updated_at, id)`
   * ascending and therefore cannot be combined with `sort` or a
   * descending `direction` — the server refuses that rather than picking
   * a winner, and a cursor issued under one ordering is refused under the
   * other. Inclusive, because `updated_at` is a millisecond timestamp
   * that ties across a bulk write; deduplicate by id, and expect a
   * high-water mark sitting on a bulk write's instant to re-send that
   * whole group on every reconnect.
   *
   * It reports changes, never removals. A purge leaves no row behind, so
   * pruning a local copy needs the event stream as well as this read.
   */
  updated_after?: string;
  /** Exclusive upper bound on `updated_at`, closing the window
   *  `updated_after` opens. Exclusive where its lower twin is inclusive:
   *  an end point the caller chooses rather than a resume point that must
   *  not drop a tie. It leaves the ordering alone. */
  updated_before?: string;
  limit?: number;
  cursor?: string;
  /**
   * Opt-in tokens on the list response, comma-separated. Three hydrate an
   * extra onto the rows already being returned; `system` widens the row set
   * instead, so they are not all one kind of thing and the difference is the
   * one worth reading below. The typed helpers `listWithMetadata` and
   * `listWithExtensions` cover the first kind, and take the second as
   * {@link SystemTypesOptIn.includeSystemTypes} because they have already
   * spent this parameter on their own token.
   *
   * - `system` — also returns `system.*` rows, which are omitted by
   *   default. A read that prunes against its result needs this, or every
   *   reserved row reads as one the server no longer has.
   * - `metadata` — wraps each entry as `{ item, metadata }`.
   * - `edges` — hydrates outbound edges per item grouped by type.
   * - `extensions` — hydrates extension namespaces (filtered by caller
   *   permissions, same rule as `GET /items/:id/extensions`).
   *
   * Lists are lean by default; opt into extras when the UI needs them
   * to avoid N+1 per-item round trips.
   */
  include?: string;
}

/**
 * The `system` opt-in, for the list helpers that spend `include` themselves.
 *
 * `include` is one parameter doing two jobs: three of its tokens hydrate an
 * extra onto the rows already coming back, and `system` widens which rows
 * those are. A helper that hydrates has spent the parameter on the first job
 * before the caller sees it, so the second arrives as a named option instead
 * of being unreachable.
 *
 * Declared once and referenced, rather than restated on each helper. The two
 * halves that have to agree are this flag and the token the helper appends,
 * and a second copy of the flag is a second thing to forget when a helper is
 * added.
 */
export interface SystemTypesOptIn {
  /**
   * Also return `system.*` rows, which the route omits by default.
   *
   * A read that wants to know what the server holds — rather than what a
   * person would browse — needs this. A client pruning against a walk
   * without it removes every reserved row it holds, because they are absent
   * from the read and indistinguishable from rows the server no longer has.
   */
  includeSystemTypes?: boolean;
}

/** Item paired with its hydrated extension namespaces. */
export type ItemWithExtensions = Item & {
  extensions: Record<string, Record<string, unknown>>;
};

/** Hydrated edges grouped by edge type — the shape carried on `item.edges`
 *  (outbound) and on a detail read's `backrefs` (inbound). */
export type HydratedEdges = Record<string, PaginatedResult<Edge>>;

/** Opt-in blocks for {@link MarfaClient.items.getDetail}. Each widens the
 *  single-item read with one more slice of the item's 1-hop neighborhood,
 *  collapsing a per-section fan-out into one request. */
export type ItemDetailInclude = "backrefs" | "neighbors" | "versions";

/**
 * The single-item read with its 1-hop neighborhood. The base — `item` (with
 * outbound `edges` hydrated) plus `metadata` — is always present; the optional
 * blocks appear only when the matching {@link ItemDetailInclude} token is
 * requested. `neighbors` are permission-filtered server-side: an item the
 * caller cannot read is omitted, never leaked.
 */
export interface ItemDetail {
  item: Item & { edges?: HydratedEdges };
  metadata: Metadata;
  backrefs?: HydratedEdges;
  neighbors?: ItemWithMetadata[];
  /**
   * `true` when the 1-hop neighbor set was capped — more neighbors exist than
   * were hydrated into `neighbors`. Present only when `neighbors` is requested.
   * Distinct from the per-type edge block's `next_cursor`: several edge types can
   * each sit below their per-type cap while their COMBINED set overflows, and
   * only this flag catches that. Treat every neighbor-derived view as
   * incomplete when it is set and page the per-type edge/backref reads.
   */
  neighbors_truncated?: boolean;
  versions?: Version[];
}

export interface SearchFilters {
  type?: string;
  /** Lifecycle state. Omitting the field answers the active state, as a
   *  listing does. `"any"` widens to every state the index holds, which is
   *  every state but `trashed`: a trashed row leaves the index rather than
   *  being narrowed out of the query. */
  state?: ItemState | "any";
  /** Tier filter, matching `ListFilters.tier`. */
  tier?: Tier | "all";
  /** Items must have ALL specified tags (AND semantics). Matches
   *  `ListFilters.tags` and `/items?tags=`. */
  tags?: string[];
  filter?: string;
  limit?: number;
  /** The previous page's `next_cursor`. */
  cursor?: string;
  /**
   * Comma-separated opt-in inclusions, the same parameter `ListFilters` takes.
   *
   * `system` widens the row set to reserved-namespace items, which search
   * excludes by default. It is the only token this route reads, and a `type`
   * filter inside the `system.` namespace opts in without it.
   *
   * Declared here so a caller can reach those rows through search as the
   * sibling listing can: `search` spreads its filters straight into the
   * query, so the declaration is all the route needs.
   */
  include?: string;
}

export interface MetadataInput {
  tags?: string[];
}

/**
 * One shipped type an instance still carries that its running build no
 * longer names, as returned by the operator drift listing.
 *
 * The seed is an upsert with no prune, so deleting a type's JSON removes
 * it from a fresh instance and from no existing one. `/health` publishes
 * only the count of these, because it is unauthenticated; the identifiers
 * live here, behind a read the operator key gates.
 */
export interface DriftedPlatformType {
  id: string;
  /** Items carrying this identifier. Read live on
   *  each request rather than cached at boot, because it is the part of
   *  the report that changes without a restart. */
  item_count: number;
  /** Types declaring this one as their parent. A parent supplies their
   *  fields, so a removal is declined while any exist. */
  child_types: string[];
  /** Whether a removal would be accepted: no items carry it and nothing
   *  inherits from it. Advisory — the server re-derives both guards
   *  inside the request and is the authority. */
  removable: boolean;
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/** One item to create or upsert in a `POST /items/bulk` call. Shape is
 *  `CreateItemInput` plus compact outbound-only inline `edges`. */
export interface BulkItemInput {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
  state?: ItemState;
  tier?: Tier;
  occurred_at?: string;
  /** Ignored on the wire — server stamps `source` from the credential.
   *  Kept on the input shape for round-trip parity with /export output. */
  source?: string;
  source_id?: string;
  origin?: "user" | "ai" | "worker";
  tags?: string[];
  /** Outbound edges to reconcile in the same transaction as the item
   *  write. Replace-all semantics per edge_type. Absent = untouched. */
  edges?: Record<string, string[]>;
}

export type BulkMode = "upsert" | "create_only";

/**
 * Input to `client.items.createWithAttachments(...)`. Wraps the existing
 * blob-upload + `items.bulk` pattern: upload each attachment's blob, then
 * issue one atomic bulk call containing the host item and the `core.file.*`
 * items with inline `attached-to` edges from each attachment back to the host.
 */
export interface CreateWithAttachmentsInput {
  /** The host item — the thing the attachments are attached *to* (note,
   *  message, etc.). May carry an explicit `id` for client-minted UUIDs
   *  and arbitrary `edges` of its own (passed through unchanged into the
   *  bulk payload). */
  item: CreateItemInput & {
    id?: string;
    edges?: Record<string, string[]>;
  };
  /** Attachments in caller-passed order. The returned `attachments`
   *  array preserves the same order. Empty arrays are valid: the helper
   *  still issues one `items.bulk` call with just the host item. */
  attachments: CreateWithAttachmentsAttachment[];
  /** Edge type from each attachment back to the host. Defaults to
   *  `"attached-to"`. Override for app-specific semantics like
   *  `"cover-image"`. */
  edgeType?: string;
}

export interface CreateWithAttachmentsAttachment {
  /** Type id, e.g. `"core.file.image"`. */
  type: string;
  /** Raw blob bytes. Uploaded via `POST /blobs`. */
  blob: Uint8Array | ArrayBuffer;
  /** Sent as the `Content-Type` of the blob upload. Stamped onto the
   *  attachment item's `mime_type` property automatically. */
  mimeType: string;
  /** Caller-supplied properties for this attachment item (e.g. `width`
   *  and `height` for `core.file.image`). The helper auto-fills
   *  `blob_ref` (= upload hash) and `mime_type` after upload; do not
   *  pre-populate them. */
  properties?: Record<string, unknown>;
  /** Optional additional edges on the attachment item. The helper
   *  appends its own `[edgeType]: [hostId]` entry; if you pass a value
   *  for the same `edgeType`, your ids are merged with the host id
   *  (helper-added edges are additive, never stripping). */
  edges?: Record<string, string[]>;
  /** Explicit attachment id (defaults to a client-minted UUIDv7). */
  id?: string;
}

export interface CreateWithAttachmentsResult {
  host: Item;
  /** Attachment items in the same order as `input.attachments`. */
  attachments: Item[];
}

export interface BulkInput {
  items: BulkItemInput[];
  /** Default: `"upsert"`. */
  mode?: BulkMode;
  /** Default: `true`. When false, errors are collected per item and the
   *  batch continues past failures. */
  atomic?: boolean;
  /** Default: `false`. Whether the batch's writes also drive outbound work
   *  — webhook delivery and connector reactions. Never governs the event
   *  log: every bulk write is logged, so a client replaying the stream sees
   *  the batch whatever this is set to. */
  enable_fanout?: boolean;
}

export type BulkOutcome = "created" | "updated" | "skipped" | "errored";

export interface BulkResultEntry {
  index: number;
  outcome: BulkOutcome;
  id?: string;
  reason?: string;
  error?: { code: string; message: string };
}

export interface BulkResult {
  counts: {
    created: number;
    updated: number;
    skipped: number;
    errored: number;
  };
  results: BulkResultEntry[];
  /** Present only on archive-restore paths. */
  blobs_imported?: number;
}

/** One edge to create or upsert in a `POST /edges/bulk` call. */
export interface BulkEdgeInputItem {
  /** Optional server-id override. Server-generated UUIDv7 otherwise. */
  id?: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties?: Record<string, unknown>;
  /** The version this entry was based on, where the triple resolves an edge
   *  that already exists. Optional: an entry creating one has none to name. */
  version?: number;
}

export interface BulkEdgeInput {
  edges: BulkEdgeInputItem[];
  /** Default: `"upsert"`. On duplicate `(source_id, target_id, edge_type)`:
   *  `"upsert"` replaces properties in place; `"create_only"` skips with
   *  reason `"duplicate_edge"`. */
  mode?: BulkMode;
  /** Default: `true`. When false, errors are collected per edge and the
   *  batch continues past failures. */
  atomic?: boolean;
  /** Default: `false`. Whether the batch's writes also drive outbound work
   *  — webhook delivery and connector reactions. Never governs the event
   *  log: every bulk write is logged, so a client replaying the stream sees
   *  the batch whatever this is set to. */
  enable_fanout?: boolean;
}

export interface BulkEdgeResultEntry {
  index: number;
  outcome: BulkOutcome;
  id?: string;
  reason?: string;
  error?: { code: string; message: string };
}

export interface BulkEdgeResult {
  counts: {
    created: number;
    updated: number;
    skipped: number;
    errored: number;
  };
  results: BulkEdgeResultEntry[];
}

/** Filter shape for `POST /items/bulk-actions`. Close to the `GET /items`
 *  query grammar — every field is AND-composed and `filter` accepts the
 *  full filter-SQL DSL — but narrower on one axis: this route has no
 *  `"any"` / `"all"` catch-all on `tier`, and refuses it with a 400
 *  rather than ignoring it. Widen it only if the route does.
 *
 *  `state` takes every lifecycle value, `revoked` included, because the
 *  route's filter does. That is not incidental: the reserved namespace's
 *  lifecycle is exactly `active` and `revoked`, so a filter offering
 *  three states put every reserved row beyond the reach of any bulk
 *  action. Narrowing this field here would rebuild that wall one layer
 *  up, where it would be harder to see.
 *
 *  **The filter's `state` and an action's own `state` are different
 *  sets and the difference is deliberate.** This one selects rows and
 *  takes four; `transition`'s target takes three, because a bulk action
 *  may not move a row into `revoked`. Reading one from the other is the
 *  mistake this note exists to stop. */
export interface BulkActionFilter {
  type?: string;
  state?: ItemState;
  source?: string;
  tier?: Tier;
  tags?: string[];
  occurred_after?: string;
  occurred_before?: string;
  /** Same grammar as `GET /items?filter=`. `edge[type]=id` shorthand
   *  becomes `edge[type] eq "id"` here. */
  filter?: string;
}

/** Shared knobs every bulk action accepts. */
interface BulkActionBase {
  filter?: BulkActionFilter;
  dry_run?: boolean;
  max_items?: number;
  /** Default: `false`. Whether the action's writes also drive outbound work
   *  — webhook delivery and connector reactions. Never governs the event
   *  log: every write the action makes is logged either way. */
  enable_fanout?: boolean;
}

/** Discriminated union over the six bulk actions. The compiler pins the
 *  per-case parameters at the call site — no runtime string fiddling. */
export type BulkActionInput =
  | (BulkActionBase & {
      action: "transition";
      state: "active" | "archived" | "trashed";
    })
  | (BulkActionBase & {
      action: "purge";
      /** Required literal. The server returns `400 bulk_confirmation_required`
       *  without it; the SDK throws the same shape before sending. */
      confirm: "PURGE";
    })
  | (BulkActionBase & {
      action: "update_tags";
      add?: string[];
      remove?: string[];
    })
  | (BulkActionBase & { action: "update_tier"; tier: Tier })
  | (BulkActionBase & {
      action: "update_properties";
      patch: Record<string, unknown>;
    })
  | (BulkActionBase & { action: "update_occurred_at"; occurred_at: string });

export interface BulkActionErrorEntry {
  id: string;
  code: string;
  message: string;
}

export interface BulkActionResult {
  action: string;
  matched: number;
  succeeded: number;
  errored: number;
  dry_run: boolean;
  /** Present when matched / succeeded is small enough to be useful
   *  (dry-run always, otherwise when succeeded ≤ 100). */
  ids?: string[];
  errors?: BulkActionErrorEntry[];
  /** Unique blob hashes referenced by items in a `purge` action. Not an
   *  orphan count: the orphan report is `GET /blobs/orphans`. Omitted for
   *  non-purge actions. */
  blob_hashes_referenced?: number;
}

/** Terminal vs non-terminal lifecycle states for a `bulk_action` job.
 *  Terminal values (`completed`, `failed`, `canceled`) freeze the row;
 *  the worker only mutates `queued` → `in_progress` → terminal. */
export type BulkActionJobStatus =
  "queued" | "in_progress" | "completed" | "failed" | "canceled";

/**
 * Whether a failed bulk-action status poll describes the question failing
 * rather than the job failing.
 *
 * Deliberately a small allow-list rather than "anything that is not a 4xx".
 * A poll runs up to thirty minutes, so treating an unrecognized failure as
 * transient means spending that budget on something that will never
 * succeed, and reporting the wrong cause when it finally gives up.
 */
function isTransientStatusFailure(error: unknown): boolean {
  if (!(error instanceof MarfaError)) return false;
  // Status 0 is the transport's own failure rather than the server's.
  if (error.code === "timeout" || error.code === "network_error") return true;
  return isBackpressure(httpStatusOf(error));
}

/**
 * The HTTP status a `MarfaError` describes, which is not always `status`.
 *
 * The transport parses a response body before it checks `ok`, so a 5xx whose
 * body is not the server's JSON envelope throws `parse_error` with `status: 0`
 * and the real code only in `details.httpStatus`. **That is the shape a 502,
 * 503 or 504 takes in front of a loaded instance**, where the error page comes
 * from a gateway rather than from the app — so a rule reading `status` alone
 * misses the most likely 5xx there is, which is the exact case the retry above
 * exists for.
 */
function httpStatusOf(error: MarfaError): number {
  if (error.status !== 0) return error.status;
  const carried = error.details?.httpStatus;
  return typeof carried === "number" ? carried : 0;
}

/** Whether a status says "ask again later" rather than "stop asking".
 *
 *  `Retry-After` is not honored: `throwForError` does not carry response
 *  headers, so the value cannot be read from here. A 429 is therefore re-asked
 *  on the poll's own backoff, which is capped at `maxPollIntervalMs`. A caller
 *  expecting to be rate-limited should raise that cap rather than rely on this
 *  being polite. */
function isBackpressure(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Polling knobs accepted by `bulkAction()`. Default polling is
 *  250ms → 500ms → 1s → 2s exponential, capped at the global max,
 *  with a 30-minute total wall-clock budget. */
export interface BulkActionPollOptions {
  /** Initial poll interval (ms). Default 250. */
  pollIntervalMs?: number;
  /** Backoff ceiling (ms). Default 2000. */
  maxPollIntervalMs?: number;
  /** Total wait budget (ms). Default 30 minutes. */
  maxWaitMs?: number;
  /** Per-request timeout for one status poll (ms). Defaults to the
   *  client's own `timeoutMs`. This is the ceiling on how long a single
   *  status response may take, not on how long the job may run — that
   *  is `maxWaitMs`. A poll that exceeds it is waited out and asked
   *  again rather than ending the wait. */
  statusTimeoutMs?: number;
  /** Called after each non-terminal poll. Useful for surfacing
   *  progress to a UI without consumers having to drive polling
   *  themselves via `bulkActionAsync` + `bulkActionStatus`. */
  onProgress?: (job: BulkActionJob) => void;
}

/** Async-job envelope returned by `POST /items/bulk-actions` (non-dry-run)
 *  and by `GET /items/bulk-actions/jobs/:id`. The SDK's `bulkAction()`
 *  resolves with the embedded `BulkActionResult` once `status` is
 *  terminal; advanced callers using `bulkActionAsync()` receive the
 *  envelope directly and drive their own polling. */
export interface BulkActionJob {
  id: string;
  action: string;
  status: BulkActionJobStatus;
  /** Frozen at job-create time after the route's pagination phase. */
  matched: number;
  processed: number;
  succeeded: number;
  errored: number;
  /** ISO 8601; present once the worker has claimed the job. */
  started_at?: string;
  /** ISO 8601; present once the worker has reached a terminal state. */
  finished_at?: string;
  /** Failure reason. Populated on `status === 'failed'`. */
  error?: string;
  /** Final result envelope. Populated on `status === 'completed'`;
   *  absent on `canceled` (whole-or-nothing — partial counts live on
   *  the envelope's `processed`/`succeeded`/`errored` fields). */
  result?: BulkActionResult;
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

/**
 * One event falling inside the window a caller asked for.
 *
 * Times are ISO 8601 UTC instants, kept as the strings the server sent.
 * The clock an event is actually read on belongs to the event, not to the
 * occurrence: `item.properties.timezone` anchors the start,
 * `end_timezone` covers an event ending somewhere else, and `all_day`
 * marks one that occupies calendar dates rather than a span of time.
 * Parsing these into `Date` here would resolve every one of them against
 * whatever zone the runtime happens to sit in, so the instant and the
 * zone are handed back side by side and the caller picks the clock.
 */
export interface Occurrence {
  /** Start instant, ISO 8601 UTC. */
  starts_at: string;
  /** End instant, ISO 8601 UTC. Absent when the event carries no end. */
  ends_at?: string;
  /** The event to show: the series itself for a computed occurrence, the
   *  stored item for one an exception replaced. */
  item: Item;
  /** Item id of the series this was expanded from. Absent on a single
   *  event. */
  series_id?: string;
  /** Start instant of the occurrence a stored exception replaced. Carried
   *  by the replacement, which is shown at its own times — those can sit
   *  outside the window the occurrence it replaced sat in. */
  replaces?: string;
}

/** One failure found in a series' recurrence rule. A row reported twice
 *  produces two of these, both carrying its id. */
export interface OccurrenceSeriesError {
  /** Item id of the series. */
  item_id: string;
  message: string;
}

/**
 * What one occurrences read cost, and the bound it is measured against.
 *
 * Present on every successful read rather than only on a refusal: a
 * ceiling a caller hears about only when it fires announces itself too
 * late to act on.
 */
export interface OccurrencesScan {
  /**
   * Event rows the request read, summed across its passes. Two of the
   * three cannot be narrowed by the window, so this grows with the size
   * of the calendar rather than with the window asked for.
   */
  events_read: number;
  /** Occurrences returned: the length of `data`. */
  occurrences: number;
  /**
   * Ceiling `occurrences` is refused at. Reported on every successful
   * read so a calendar approaching it is visible before a request is
   * refused, rather than only once one is.
   */
  max_occurrences: number;
  /**
   * Failures the read found in recurrence rules, counted across the
   * event types it read.
   *
   * Entries rather than rows, matching the `series_errors` array: one
   * row can account for two — an unreadable line dropped from its rule,
   * and then a failure expanding what was left — so this is an upper
   * bound on how many rows to go and look at. Group on `item_id` for
   * the exact number.
   *
   * Scoped to those types rather than to the instance. A `type` on the
   * request, or a credential permissioned for one event type, narrows
   * what was read and therefore what this counts, so a zero says the
   * rules this read looked at were fine and says nothing at all about
   * the ones it did not.
   *
   * It counts everything this read detected, even when `series_errors`
   * on the result lists fewer, which is what lets a caller tell a
   * handful of broken rules from a corrupt import without being sent the
   * bytes of the larger one. A floor rather than a certificate: it
   * counts the ways of being broken the server knows how to recognize,
   * so zero is the absence of a detected failure and not a proof of
   * health.
   */
  series_errors: number;
  /**
   * Longest list of failures the response will carry, counted in
   * entries. Past this the list is capped rather than the read refused,
   * and `series_errors_truncated` is set.
   *
   * Entries rather than rows, and failures rather than *expansion*
   * failures: one row can account for two, and most of the classes
   * counted here never reach the expander at all — an unreadable rule
   * and a timezone that does not resolve both fail before a single
   * iteration is spent.
   */
  max_series_errors: number;
  /**
   * Rule iterations the read spent on expansions that returned no
   * occurrence: a rule that ended before the window or produced nothing
   * in it, one too frequent to reach the window before the per-series
   * iteration ceiling, and one refused for flooding the window — that
   * last having produced occurrences the refusal discarded, so the
   * predicate is what the expansion returned rather than what the rule
   * computed. It is not a count of what reached `data`, which the server
   * assembles later behind a filter this charge does not consult.
   *
   * Only iterations count. A series that fails before it iterates — an
   * unreadable rule, a timezone that does not resolve — is reported in
   * `series_errors` and charges nothing here.
   *
   * The unit the expansion ceiling is denominated in, reported on every
   * read rather than only on the one it truncates.
   */
  unproductive_iterations: number;
  /**
   * Ceiling `unproductive_iterations` stops the expansion at. Iterations
   * spent on series that do produce occurrences are never counted
   * against it, so a calendar cannot cross it by holding many meetings.
   */
  max_unproductive_iterations: number;
  /**
   * Series left unexpanded because the ceiling was reached first. Zero
   * on a read that finished; above zero, `expansion_incomplete` is set
   * and the calendar may be missing what those series held.
   */
  series_unexpanded: number;
}

export interface OccurrencesResult {
  data: Occurrence[];
  /** Always `null`: the window is the whole answer. */
  next_cursor: null;
  /** The window actually read, normalized to UTC. */
  window: { from: string; to: string };
  /** What this read cost and what would stop it. */
  scan: OccurrencesScan;
  /**
   * One entry per failure the server found in a recurrence rule —
   * malformed, flooding the window, carrying no start to unfold from,
   * carrying a timezone that does not resolve, or holding something that
   * is not an RFC 5545 property line. `item_id` names the row and one
   * row can appear twice. The rest of the calendar still
   * returns, so a caller ignoring this renders a calendar with a
   * repeating meeting silently absent from it, or a repeating meeting
   * silently shown once.
   *
   * Capped in both length and message size by the server. Past that cap
   * the list is trimmed and `series_errors_truncated` says so, while
   * `scan.series_errors` keeps the true count. The read still succeeds:
   * this list is a diagnostic beside the calendar and nothing in `data`
   * depends on it, so a shorter list costs the caller nothing from the
   * calendar itself.
   */
  series_errors?: OccurrenceSeriesError[];
  /**
   * Set when `series_errors` lists fewer failures than the read found.
   *
   * Worth branching on if the list is being shown to a person: it is the
   * difference between "these are the failures" and "these are 500 of
   * them".
   */
  series_errors_truncated?: boolean;
  /**
   * Set when the server stopped expanding series before it had walked
   * them all, having spent its whole expansion budget on expansions that
   * returned no occurrence.
   *
   * `data` is a partial calendar when this is set, and
   * `scan.series_unexpanded` says how many series were left. A narrower
   * window will not help — the budget is spent walking rules from their
   * own start, before the window is reached — so the move is a `type`
   * narrowing, or fixing the rules `series_errors` names.
   *
   * The same two fields appear in a `ValidationError`'s `details` when
   * the occurrence ceiling refuses a read whose expansion had already
   * been truncated — see `occurrences.list`, which is where a caller
   * meets them, because that refusal is a thrown error rather than this
   * result. That refusal says to narrow the window, and these say that
   * narrowing it still returns a partial calendar.
   */
  expansion_incomplete?: boolean;
}

export interface ListOccurrencesOptions {
  /** Window start, inclusive. A `Date` is sent as its UTC instant. */
  from: string | Date;
  /** Window end, exclusive. */
  to: string | Date;
  /**
   * Restrict to one event type. Defaults to every event type the
   * credential can read.
   *
   * A valid type that holds no events is not an error: the read succeeds
   * with an empty `data`, the same answer a window with nothing in it
   * gives. Only a malformed identifier is refused.
   */
  type?: string;
}

// ---------------------------------------------------------------------------
// Secure storage protocol
// ---------------------------------------------------------------------------

/** Minimal contract for the credential store consumed by
 *  `MarfaClient.fromSecureStorage()`. Implementations need only support
 *  `get(account)`; richer operations belong to the implementing module. */
export interface SecureStorage {
  /** Returns the stored API key for `account`, or `null` when absent. */
  get(account: string): Promise<string | null>;
}

/**
 * A key identifying one logical write, so a retry after a lost response
 * learns what the first attempt did instead of colliding with it.
 *
 * The server records the status and body it returned and answers a repeat
 * carrying the same key from that record, performing no second write. Use
 * one fresh key per write and reuse it only when retrying that same write:
 * a key sent with a different request is refused, since serving the stored
 * result there would silently discard a write the caller believes it made.
 *
 * Offered only on the methods that issue exactly one request with exactly
 * one body. `items.update` and `edges.update` are absent deliberately — a
 * conflict strategy may re-send a merged body, and that second body under
 * the first body's key is the refusal above rather than a retry.
 */
export interface IdempotentWriteOptions {
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MarfaClient {
  private readonly transport: HttpTransport;
  private readonly defaultConflictStrategy: ConflictStrategy;
  private readonly defaultOnConflictAutoMerge?: ConflictAutoMergeListener;

  constructor(config: ClientConfig) {
    this.transport = new HttpTransport({
      baseUrl: config.url,
      apiKey: config.apiKey,
      tokenProvider: config.tokenProvider,
      fetch: config.fetch,
      timeoutMs: config.timeoutMs,
    });
    this.defaultConflictStrategy = config.conflictStrategy ?? "auto";
    this.defaultOnConflictAutoMerge = config.onConflictAutoMerge;
  }

  // -------------------------------------------------------------------------
  // Static factories
  // -------------------------------------------------------------------------

  /**
   * Builds a client from process environment variables.
   *
   * Reads `MARFA_API_URL` and `MARFA_API_KEY` from `globalThis.process.env`.
   * Returns `null` if either is missing or empty, or if `process` is not
   * available (e.g. browser context with no shim) — callers decide how to
   * fall back.
   */
  static fromEnvironment(
    extra: Omit<ClientConfig, "url" | "apiKey" | "tokenProvider"> = {},
  ): MarfaClient | null {
    const env = (
      globalThis as { process?: { env?: Record<string, string | undefined> } }
    ).process?.env;
    const url = env?.MARFA_API_URL;
    const apiKey = env?.MARFA_API_KEY;
    if (!url || !apiKey) return null;
    return new MarfaClient({ url, apiKey, ...extra });
  }

  /**
   * Builds a client by loading the API key from a `SecureStorage`-shaped
   * store. The secret-storage abstraction is protocol-only, so callers can
   * plug in a file-backed store, an OS keyring binding, or an in-memory
   * mock.
   *
   * Throws when the storage does not carry a value for `account`.
   */
  static async fromSecureStorage(
    options: {
      storage: SecureStorage;
      account: string;
      url: string;
    } & Omit<ClientConfig, "url" | "apiKey" | "tokenProvider">,
  ): Promise<MarfaClient> {
    const apiKey = await options.storage.get(options.account);
    if (!apiKey) {
      throw new Error(
        `No API key found in secure storage for account "${options.account}".`,
      );
    }
    // Named only to keep them out of `rest`, which becomes the client's
    // config. The lint rule this repository runs exempts neither a rest
    // sibling nor an underscore, so each is discarded where it is named
    // rather than through a disable comment.
    const { storage, account, ...rest } = options;
    void storage;
    void account;
    return new MarfaClient({ ...rest, apiKey });
  }

  // ---- Items ----

  readonly items = {
    create: async (
      input: CreateItemInput & {
        /** Atomic edges payload: for each edge type, listed ids become
         *  targets with the new item as source. */
        edges?: Record<string, string[]>;
      },
      options?: IdempotentWriteOptions,
    ): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "POST",
        "/items",
        {
          body: input,
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        },
      );
      return res.item;
    },

    /**
     * Create-or-update an item, surfacing whether the server resolved as a
     * fresh create (HTTP 201) or a natural-key match update (HTTP 200).
     *
     * `POST /items` accepts a `(source, source_id)` pair as a stable
     * natural key: a second POST with the same pair updates the existing
     * row in place rather than 409ing. The wire shape returned is
     * `{ item }` regardless — the only signal of "created vs updated" is
     * the HTTP status code, which `transport.request` consumes internally.
     * This method threads the status out so callers can surface the
     * distinction (e.g. CLI `Created.` vs `Updated (natural-key match).`).
     *
     * Use `items.create` when the caller does not need the distinction —
     * the wire shape is identical.
     */
    upsert: async (
      input: CreateItemInput & {
        /** Atomic edges payload, same semantics as `items.create`. */
        edges?: Record<string, string[]>;
      },
    ): Promise<{ item: Item; created: boolean }> => {
      const { data, status } = await this.transport.requestWithStatus<{
        item: Item;
      }>("POST", "/items", { body: input });
      return { item: data.item, created: status === 201 };
    },

    get: async (id: string): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "GET",
        path`/items/${id}`,
      );
      return res.item;
    },

    /**
     * Read a single item with its 1-hop neighborhood in one round trip.
     *
     * `GET /items/:id` already returns the item's `metadata` layer and its
     * outbound `edges` inline; this method surfaces that envelope (which the
     * lean `get` discards) and lets the caller widen it via `include`:
     *
     * - `backrefs` — inbound edges grouped by type (same block shape as
     *   `item.edges`), capped + cursored per type.
     * - `neighbors` — the far-end items of the item's edges (outbound targets,
     *   plus inbound sources when `backrefs` is also requested), each with its
     *   metadata and permission-filtered.
     * - `versions` — the item's version snapshots, newest-first.
     *
     * One bundled read replaces the open-a-detail fan-out (item, metadata, and
     * a per-section edge/backref/hydration request each). Overflow edges beyond
     * the per-type cap stay reachable via `items.edges` / `items.backrefs`.
     */
    getDetail: async (
      id: string,
      opts?: { include?: ItemDetailInclude[] },
    ): Promise<ItemDetail> => {
      const include = opts?.include?.length
        ? opts.include.join(",")
        : undefined;
      return this.transport.request<ItemDetail>("GET", path`/items/${id}`, {
        ...(include ? { query: { include } } : {}),
      });
    },

    /**
     * Read many items by id in one round-trip via `POST /items/bulk-get`.
     * Permission-filtered exactly like `get`: ids the caller cannot read
     * (type not permitted, trashed, or non-existent) are silently omitted, so the returned array may be
     * shorter than `ids` and is in no guaranteed order. Capped at 100 ids
     * server-side — an over-cap request throws a `validation_error`.
     *
     * `opts.include` takes the same tokens as the list endpoint, and they are
     * not all the same kind of thing. `edges`, `metadata` and `extensions`
     * hydrate an extra inline, collapsing what would otherwise be one request
     * per id. `system` does not: it widens which items come back, and without
     * it a `system.*` id you asked for by name is dropped from the array
     * silently, the same way an unreadable id is. The `system` bullet on
     * {@link ListFilters.include} says what that costs a client reconciling a
     * local store.
     */
    getMany: async (
      ids: string[],
      opts?: {
        include?: ("edges" | "metadata" | "extensions" | "system")[];
      },
    ): Promise<Item[]> => {
      if (ids.length === 0) return [];
      const res = await this.transport.request<{ items: Item[] }>(
        "POST",
        "/items/bulk-get",
        { body: { ids, ...(opts?.include && { include: opts.include }) } },
      );
      return res.items;
    },

    list: async (filters?: ListFilters): Promise<PaginatedResult<Item>> => {
      return this.transport.request<PaginatedResult<Item>>("GET", "/items", {
        query: filters,
      });
    },

    listWithMetadata: async (
      filters?: Omit<ListFilters, "include"> & SystemTypesOptIn,
    ): Promise<PaginatedResult<ItemWithMetadata>> => {
      const { includeSystemTypes, ...rest } = filters ?? {};
      return this.transport.request<PaginatedResult<ItemWithMetadata>>(
        "GET",
        "/items",
        {
          query: {
            ...rest,
            include:
              includeSystemTypes === true ? "metadata,system" : "metadata",
          },
        },
      );
    },

    /**
     * List items with their extension namespaces hydrated inline. Avoids
     * the N+1 pattern of listing then calling `GET /items/:id/extensions`
     * per item. Extensions are filtered by the caller's permissions —
     * admins see every namespace, members see what they can read or
     * write.
     */
    listWithExtensions: async (
      filters?: Omit<ListFilters, "include"> & SystemTypesOptIn,
    ): Promise<PaginatedResult<ItemWithExtensions>> => {
      const { includeSystemTypes, ...rest } = filters ?? {};
      return this.transport.request<PaginatedResult<ItemWithExtensions>>(
        "GET",
        "/items",
        {
          query: {
            ...rest,
            include:
              includeSystemTypes === true ? "extensions,system" : "extensions",
          },
        },
      );
    },

    /**
     * Every item matching the filters, across as many pages as it takes.
     *
     * Lazy: one page is in flight at a time and a consumer that breaks out
     * stops the walk. Pass `limit` to size the pages; `cursor` is the walk's
     * own business and is not accepted here. Wrap in `collect` when an array
     * is genuinely wanted, which is where the ceiling gets named.
     */
    listAll: (filters?: Omit<ListFilters, "cursor">): AsyncIterable<Item> =>
      paginate((cursor) =>
        this.items.list({ ...filters, ...(cursor ? { cursor } : {}) }),
      ),

    /**
     * `listAll` with metadata hydrated inline.
     *
     * Carries {@link SystemTypesOptIn} because this is the helper a caller
     * that wants everything reaches for, and without it the walk returned
     * everything except the reserved namespace — with nothing at the call
     * site to say so.
     */
    listAllWithMetadata: (
      filters?: Omit<ListFilters, "include" | "cursor"> & SystemTypesOptIn,
    ): AsyncIterable<ItemWithMetadata> =>
      paginate((cursor) =>
        this.items.listWithMetadata({
          ...filters,
          ...(cursor ? { cursor } : {}),
        }),
      ),

    /** `listAll` with extension namespaces hydrated inline. */
    listAllWithExtensions: (
      filters?: Omit<ListFilters, "include" | "cursor"> & SystemTypesOptIn,
    ): AsyncIterable<ItemWithExtensions> =>
      paginate((cursor) =>
        this.items.listWithExtensions({
          ...filters,
          ...(cursor ? { cursor } : {}),
        }),
      ),

    update: async (
      id: string,
      properties: Record<string, unknown>,
      options?: UpdateOptions,
    ): Promise<Item> => {
      const expected = options?.expectedVersion;
      let version: number;
      if (expected !== undefined) {
        version = expected;
      } else {
        version = (await this.items.get(id)).version;
      }

      const strategy = options?.conflict ?? this.defaultConflictStrategy;
      const onAutoMerge =
        options?.onAutoMerge ?? this.defaultOnConflictAutoMerge;

      return handleConflictUpdate(
        this.transport,
        id,
        properties,
        version,
        strategy,
        options?.resolve,
        options?.tier,
        onAutoMerge,
        options?.source_id,
        options?.idempotencyKey,
      );
    },

    delete: async (
      id: string,
      options?: IdempotentWriteOptions,
    ): Promise<void> => {
      await this.transport.request<undefined>("DELETE", path`/items/${id}`, {
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    /** Permanently delete a trashed item (admin only). Item must already
     * be in state "trashed"; returns 400 otherwise. Irreversible. */
    purge: async (id: string): Promise<void> => {
      await this.transport.request<{ ok: true }>(
        "DELETE",
        path`/items/${id}/purge`,
      );
    },

    restore: async (id: string): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "POST",
        path`/items/${id}/restore`,
      );
      return res.item;
    },

    transition: async (id: string, state: string): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "POST",
        path`/items/${id}/transition`,
        { body: { state } },
      );
      return res.item;
    },

    versions: async (id: string): Promise<Version[]> => {
      const res = await this.transport.request<PaginatedResult<Version>>(
        "GET",
        path`/items/${id}/versions`,
      );
      return res.data;
    },

    stats: async (): Promise<Record<string, number>> => {
      return this.transport.request<Record<string, number>>(
        "GET",
        "/items/stats",
      );
    },

    /**
     * Create or upsert many items in one call (admin-only). Up to 5000
     * items per call.
     *
     * Modes: `"upsert"` (default) updates matching `(source, source_id)`
     * rows in place; `"create_only"` surfaces matches as `skipped`.
     * `atomic: true` (default) rolls back the whole batch on any failure.
     */
    bulk: async (input: BulkInput): Promise<BulkResult> => {
      return this.transport.request<BulkResult>("POST", "/items/bulk", {
        body: input,
      });
    },

    /**
     * Create a host item plus a set of attached `core.file.*` items in
     * one call. Wraps the existing `blobs.upload` + `items.bulk`
     * primitives: each attachment's blob is uploaded concurrently, then a
     * single atomic bulk call writes the host and the attachments
     * together with inline `attached-to` edges from each attachment back
     * to the host.
     *
     * **Partial-failure contract.** Blob uploads run concurrently via
     * `Promise.all`. On upload failure, throws with the failing
     * attachment's index in the message. Successfully-uploaded blobs are
     * not cleaned up; the server's CAS dedupe (`blob_ref` is the
     * content hash) makes orphaned uploads cost-trivial — the same bytes
     * uploaded later resolve to the same hash. Callers are expected to
     * retry the whole call rather than reason about partial state.
     *
     * **Empty `attachments`** is valid and supported: the helper still
     * issues one `items.bulk` call with just the host item, no blob
     * uploads, no auto-edges. Lets callers use this method as a uniform
     * entry point regardless of whether attachments are present.
     *
     * **Caller-provided edges co-exist with the auto-`attached-to`
     * edges.** If the caller passes edges on the host item, they're
     * passed through unchanged. If the caller passes edges on an
     * attachment item with the same `edgeType` key, the helper's host id
     * is appended to that array (additive, never strip-and-replace).
     */
    createWithAttachments: async (
      input: CreateWithAttachmentsInput,
    ): Promise<CreateWithAttachmentsResult> => {
      const edgeType = input.edgeType ?? "attached-to";
      const hostId = input.item.id ?? generateId();

      // Rewrap any blob upload error to include the attachment index —
      // the caller needs to know which one failed.
      const uploadResults = await Promise.all(
        input.attachments.map(async (att, idx) => {
          try {
            return await this.blobs.upload(att.blob, att.mimeType);
          } catch (err) {
            throw new MarfaError(
              "blob_upload_failed",
              `createWithAttachments: blob upload failed for attachments[${String(idx)}] (type=${att.type}): ${err instanceof Error ? err.message : String(err)}`,
              502,
            );
          }
        }),
      );

      const hostBulkItem: BulkItemInput = {
        ...input.item,
        id: hostId,
      };

      const attachmentIds: string[] = [];
      const attachmentBulkItems: BulkItemInput[] = input.attachments.map(
        (att, idx) => {
          const attachmentId = att.id ?? generateId();
          attachmentIds.push(attachmentId);
          const upload = uploadResults[idx];
          if (!upload) {
            throw new MarfaError(
              "internal_error",
              `createWithAttachments: upload result missing for attachments[${String(idx)}]`,
              500,
            );
          }

          const callerEdges = att.edges ?? {};
          const callerSameType = callerEdges[edgeType] ?? [];
          const mergedEdges: Record<string, string[]> = {
            ...callerEdges,
            [edgeType]: [...callerSameType, hostId],
          };

          return {
            id: attachmentId,
            type: att.type,
            properties: {
              ...(att.properties ?? {}),
              blob_ref: upload.hash,
              mime_type: att.mimeType,
            },
            edges: mergedEdges,
          };
        },
      );

      const bulkResult = await this.items.bulk({
        items: [hostBulkItem, ...attachmentBulkItems],
        mode: "create_only",
        atomic: true,
      });

      // Any non-created outcome (errored or skipped) is a programming error
      // here — the helper guarantees fresh creates. Skips typically mean a
      // caller-supplied `input.item.id` collided with an existing row.
      const errored = bulkResult.results.find((r) => r.outcome === "errored");
      if (errored) {
        throw new MarfaError(
          errored.error?.code ?? "bulk_failed",
          `createWithAttachments: bulk write failed at index ${String(errored.index)}: ${errored.error?.message ?? errored.reason ?? "unknown"}`,
          400,
        );
      }
      const skipped = bulkResult.results.find((r) => r.outcome === "skipped");
      if (skipped) {
        throw new MarfaError(
          "duplicate_id",
          `createWithAttachments: bulk write skipped at index ${String(skipped.index)} (reason: ${skipped.reason ?? "unknown"}). The helper requires fresh ids — if you passed an explicit \`item.id\`, it must not already exist.`,
          409,
        );
      }

      // `items.bulk` returns ids, not full Items — hydrate them in a single
      // batched read instead of one GET per id. `getMany` omits any id it
      // can't resolve, so re-key the result by id and re-project in request
      // order to preserve the host-then-attachments shape callers expect.
      const requestedIds = [hostId, ...attachmentIds];
      const fetched = await this.items.getMany(requestedIds);
      const byId = new Map(fetched.map((item) => [item.id, item]));
      const host = byId.get(hostId);
      if (!host) {
        throw new MarfaError(
          "internal_error",
          "createWithAttachments: host hydration returned no item",
          500,
        );
      }
      const attachments = attachmentIds.map((id) => {
        const item = byId.get(id);
        if (!item) {
          throw new MarfaError(
            "internal_error",
            `createWithAttachments: attachment hydration returned no item for ${id}`,
            500,
          );
        }
        return item;
      });

      return { host, attachments };
    },

    /**
     * Apply one action to every item matching a filter. Six actions
     * discriminated on `action`. Purge is admin-only and requires
     * `confirm: "PURGE"` — the SDK throws a `bulk_confirmation_required`
     * `MarfaError` client-side if you forget, matching the server's 400.
     *
     * Non-admin callers see their match set narrowed to writable types
     * for every action except `purge`, which hard-403s.
     */
    bulkAction: async (
      input: BulkActionInput,
      options?: BulkActionPollOptions,
    ): Promise<BulkActionResult> => {
      if (input.action === "purge") {
        // Runtime guard for JS callers — the TS discriminated union
        // pins `confirm: "PURGE"` at compile time, but nothing stops a
        // plain-JS caller from omitting it. Mirrors the server's 400
        // bulk_confirmation_required so both error paths feel the same.
        const confirm = (input as { confirm?: string }).confirm;
        if (confirm !== "PURGE") {
          throw new MarfaError(
            "bulk_confirmation_required",
            "bulkAction({ action: 'purge' }) requires confirm: 'PURGE'",
            400,
          );
        }
      }
      const { data, status } = await this.transport.requestWithStatus<
        BulkActionResult | BulkActionJob
      >("POST", "/items/bulk-actions", { body: input });
      if (status === 200) {
        return data as BulkActionResult; // dry_run is synchronous
      }
      const queued = data as BulkActionJob;
      const final = await pollUntilTerminal({
        fetchOnce: () =>
          this.items.bulkActionStatus(queued.id, {
            timeoutMs: options?.statusTimeoutMs,
          }),
        isTerminal: (job) =>
          job.status === "completed" ||
          job.status === "failed" ||
          job.status === "canceled",
        // Asking about the job is not the job. A status response that
        // times out, fails at the network, or comes back 5xx or 429
        // says nothing about the write, which is still running on the
        // server — so the poll waits and asks again instead of throwing
        // a failure for work that is succeeding. Everything else ends
        // the poll immediately: a 404 means the job is gone and a 401
        // means the credential is, and retrying either until the
        // thirty-minute budget expires is worse than failing now.
        isRetryable: isTransientStatusFailure,
        onProgress: options?.onProgress,
        pollIntervalMs: options?.pollIntervalMs,
        maxPollIntervalMs: options?.maxPollIntervalMs,
        maxWaitMs: options?.maxWaitMs,
      });
      if (final.status === "canceled") {
        throw new BulkJobCanceledError({
          jobId: final.id,
          processed: final.processed,
          succeeded: final.succeeded,
          errored: final.errored,
        });
      }
      if (final.status === "failed") {
        throw new BulkJobFailedError({
          jobId: final.id,
          reason: final.error ?? "Unknown error",
        });
      }
      if (!final.result) {
        throw new MarfaError(
          "internal_error",
          `Bulk action job ${final.id} reached terminal status '${final.status}' but carried no result envelope`,
          0,
        );
      }
      return final.result;
    },

    /**
     * Low-level companion to `bulkAction()`. Fires the POST and returns
     * the initial job envelope without polling. Callers wanting explicit
     * control over the lifecycle (a UI that wants to surface progress
     * directly, an LLM tool returning the job id, etc.) drive polling
     * themselves via `bulkActionStatus`. Dry-run requests are still
     * synchronous on the server; this method throws with a descriptive
     * error if `dry_run: true` is set so callers don't silently lose
     * their result.
     */
    bulkActionAsync: async (input: BulkActionInput): Promise<BulkActionJob> => {
      if (input.action === "purge") {
        const confirm = (input as { confirm?: string }).confirm;
        if (confirm !== "PURGE") {
          throw new MarfaError(
            "bulk_confirmation_required",
            "bulkAction({ action: 'purge' }) requires confirm: 'PURGE'",
            400,
          );
        }
      }
      if (input.dry_run === true) {
        throw new MarfaError(
          "invalid_request",
          "bulkActionAsync does not support dry_run; use bulkAction({ dry_run: true }) for the synchronous dry-run path",
          400,
        );
      }
      const { data, status } =
        await this.transport.requestWithStatus<BulkActionJob>(
          "POST",
          "/items/bulk-actions",
          { body: input },
        );
      if (status !== 202) {
        throw new MarfaError(
          "internal_error",
          `Expected 202 from bulk_action async path, got ${String(status)}`,
          status,
        );
      }
      return data;
    },

    /** Poll a bulk_action job by id. Single GET, no polling loop.
     *
     *  The timeout falls through to the client's own rather than being
     *  pinned here: pinned, the one call most likely to be slow would be
     *  the one call whose timeout `ClientConfig.timeoutMs` could not
     *  raise. */
    bulkActionStatus: (
      jobId: string,
      options?: { timeoutMs?: number },
    ): Promise<BulkActionJob> =>
      this.transport.request<BulkActionJob>(
        "GET",
        path`/items/bulk-actions/jobs/${jobId}`,
        { timeoutMs: options?.timeoutMs },
      ),

    /** Request cancellation of a bulk_action job. Idempotent —
     *  already-terminal jobs return their existing state unchanged. */
    bulkActionCancel: (jobId: string): Promise<BulkActionJob> =>
      this.transport.request<BulkActionJob>(
        "DELETE",
        path`/items/bulk-actions/jobs/${jobId}`,
      ),

    /** Outbound edges from this item. Shortcut for edges.listFromSource. */
    edges: (
      itemId: string,
      filters?: {
        edge_type?: string | string[];
        limit?: number;
        cursor?: string;
      },
    ) => this.edges.listFromSource(itemId, filters),

    /** Inbound edges targeting this item. Shortcut for edges.listToTarget. */
    backrefs: (
      itemId: string,
      filters?: {
        edge_type?: string | string[];
        limit?: number;
        cursor?: string;
      },
    ) => this.edges.listToTarget(itemId, filters),
  };

  // ---- Metadata ----

  readonly metadata = {
    get: async (itemId: string): Promise<Metadata> => {
      const res = await this.transport.request<{ metadata: Metadata }>(
        "GET",
        path`/items/${itemId}/metadata`,
      );
      return res.metadata;
    },

    set: async (itemId: string, input: MetadataInput): Promise<Metadata> => {
      const res = await this.transport.request<{ metadata: Metadata }>(
        "PUT",
        path`/items/${itemId}/metadata`,
        { body: input },
      );
      return res.metadata;
    },

    merge: async (
      itemId: string,
      input: Partial<MetadataInput>,
    ): Promise<Metadata> => {
      const res = await this.transport.request<{ metadata: Metadata }>(
        "PATCH",
        path`/items/${itemId}/metadata`,
        { body: input },
      );
      return res.metadata;
    },

    addTags: async (itemId: string, tags: string[]): Promise<Metadata> => {
      const res = await this.transport.request<{ metadata: Metadata }>(
        "POST",
        path`/items/${itemId}/tags`,
        { body: { tags } },
      );
      return res.metadata;
    },

    removeTag: async (itemId: string, tag: string): Promise<void> => {
      await this.transport.request<{ metadata: Metadata }>(
        "DELETE",
        path`/items/${itemId}/tags/${tag}`,
      );
    },

    /**
     * Enumerate the distinct set of tags in use across items the caller can
     * read. Type-permission scoped, and counted over the active state, as
     * the item listing is, so every tag returned opens to rows.
     * Returns tags with usage counts, sorted by count desc then tag asc.
     */
    listTags: async (): Promise<{ tag: string; count: number }[]> => {
      const res = await this.transport.request<
        PaginatedResult<{ tag: string; count: number }>
      >("GET", "/metadata/tags");
      return res.data;
    },

    getExtensions: async (
      itemId: string,
      namespace?: string,
    ): Promise<Record<string, Record<string, unknown>>> => {
      if (namespace) {
        const res = await this.transport.request<{
          namespace: string;
          data: Record<string, unknown> | null;
        }>("GET", path`/items/${itemId}/extensions/${namespace}`);
        return res.data ? { [namespace]: res.data } : {};
      }
      const res = await this.transport.request<{
        extensions: Record<string, Record<string, unknown>>;
      }>("GET", path`/items/${itemId}/extensions`);
      return res.extensions;
    },

    setExtension: async (
      itemId: string,
      namespace: string,
      data: Record<string, unknown>,
    ): Promise<Record<string, Record<string, unknown>>> => {
      const res = await this.transport.request<{
        extensions: Record<string, Record<string, unknown>>;
      }>("PUT", path`/items/${itemId}/extensions/${namespace}`, { body: data });
      return res.extensions;
    },

    deleteExtension: async (
      itemId: string,
      namespace: string,
    ): Promise<void> => {
      await this.transport.request(
        "DELETE",
        path`/items/${itemId}/extensions/${namespace}`,
      );
    },
  };

  // ---- Search ----

  /** One page of hits; pass `next_cursor` back as `filters.cursor`. */
  async search(
    query: string,
    filters?: SearchFilters,
  ): Promise<PaginatedResult<SearchResult>> {
    return this.transport.request<PaginatedResult<SearchResult>>(
      "GET",
      "/search",
      { query: { q: query, ...filters } },
    );
  }

  // ---- Edges ----

  readonly edges = {
    /**
     * Global edge listing across the instance, filtered by edge type
     * (comma-separated string or array of type ids). Use this when you
     * need "all edges of type X" — replaces the walk-every-item
     * pattern. Per-target filters live on `listFromSource` /
     * `listToTarget`.
     */
    list: async (filters?: {
      edge_type?: string | string[];
      /** Inclusive lower bound on the edge's `updated_at`. The edge half
       *  of the catch-up read; orders by `(updated_at, id)` ascending, so
       *  a cursor issued without it cannot be continued with it. Reports
       *  changes and never removals: a deleted edge leaves no row and no
       *  tombstone, so the event stream is the other half. */
      updated_after?: string;
      /** Exclusive upper bound on the edge's `updated_at`, closing the
       *  window `updated_after` opens. It leaves the ordering alone. */
      updated_before?: string;
      limit?: number;
      cursor?: string;
    }): Promise<PaginatedResult<Edge>> => {
      const edgeType = Array.isArray(filters?.edge_type)
        ? filters.edge_type.join(",")
        : filters?.edge_type;
      return this.transport.request<PaginatedResult<Edge>>("GET", "/edges", {
        query: {
          ...(edgeType && { edge_type: edgeType }),
          ...(filters?.updated_after !== undefined && {
            updated_after: filters.updated_after,
          }),
          ...(filters?.updated_before !== undefined && {
            updated_before: filters.updated_before,
          }),
          ...(filters?.limit !== undefined && { limit: filters.limit }),
          ...(filters?.cursor && { cursor: filters.cursor }),
        },
      });
    },

    /** Create a single edge. Server enforces cardinality / type
     *  constraints / cycle prevention; throws on violation. */
    create: async (
      input: CreateEdgeInput,
      options?: IdempotentWriteOptions,
    ): Promise<Edge> => {
      const res = await this.transport.request<{ edge: Edge }>(
        "POST",
        "/edges",
        {
          body: input,
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        },
      );
      return res.edge;
    },

    /**
     * Update properties on an existing edge. edge_type / source / target
     * are immutable; server rejects with 400.
     *
     * `opts.version` is required: pass the `version` from the edge the edit
     * was computed against, and a write over a row that has moved on is
     * refused rather than landing on top of it. The refusal throws, carrying
     * the current edge — edges have no merge policy, so resolution is to
     * re-apply the change over that and send again.
     *
     * `opts.idempotencyKey` is honored by this door like every other write
     * door. It matters most here *because* of `version`: without a key, an
     * update whose answer was lost replays as a fresh write, and the first
     * attempt has already moved the version — so the replay is refused as a
     * conflict over an edit that in fact landed. With one, the server
     * answers the repeat from its record and the caller sees what the first
     * attempt returned.
     */
    update: async (
      id: string,
      properties: Record<string, unknown>,
      opts: { version: number } & IdempotentWriteOptions,
    ): Promise<Edge> => {
      // `requestWithConflict` rather than `request`, so the 409 body
      // survives. The generic path would throw a `MarfaError` built from
      // the error object alone, and the current edge — the only thing in
      // that body worth having — would be discarded on the way out.
      const res = (await this.transport.requestWithConflict<{ edge: Edge }>(
        "PATCH",
        path`/edges/${id}`,
        {
          body: {
            properties,
            version: opts.version,
          },
          ...(opts.idempotencyKey !== undefined && {
            idempotencyKey: opts.idempotencyKey,
          }),
        },
      )) as
        | { edge: Edge }
        | { error: { code: string; status: 409 }; current?: Edge };
      if ("error" in res) {
        // Branch on the shape rather than asserting it. This transport
        // hands back every 409 body unchanged, and only the stale-version
        // one carries the current edge. A future refusal on this route that
        // used the ordinary error envelope would otherwise reach the line
        // below with nothing to read, and the caller would get a
        // TypeError instead of an error they can handle.
        if (res.current === undefined) {
          throw new MarfaError(res.error.code, "Edge update refused", 409);
        }
        throw new EdgeConflictError(res.current);
      }
      return res.edge;
    },

    delete: async (
      id: string,
      options?: IdempotentWriteOptions,
    ): Promise<void> => {
      await this.transport.request<{ ok: true }>("DELETE", path`/edges/${id}`, {
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    /**
     * Create or upsert many edges in one call (admin-only). Up to 5000
     * edges per call.
     *
     * Modes: `"upsert"` (default) replaces properties on existing
     * `(source_id, target_id, edge_type)` triples; `"create_only"` surfaces
     * duplicates as `skipped` with reason `"duplicate_edge"`. `atomic: true`
     * (default) rolls back the whole batch on any failure — per-edge errors
     * for non-atomic mode land in each result entry.
     *
     * Sibling to `items.bulk` for edges written in bulk, where cross-item
     * edges cannot reliably ride along as inline-edge payloads on the item
     * writes.
     */
    bulk: async (input: BulkEdgeInput): Promise<BulkEdgeResult> => {
      return this.transport.request<BulkEdgeResult>("POST", "/edges/bulk", {
        body: input,
      });
    },

    /** Outbound edges — items where this id is source. Filter by edge type
     *  (comma-separated string or array of type ids). */
    listFromSource: async (
      sourceId: string,
      filters?: {
        edge_type?: string | string[];
        limit?: number;
        cursor?: string;
      },
    ): Promise<PaginatedResult<Edge>> => {
      const edgeType = Array.isArray(filters?.edge_type)
        ? filters.edge_type.join(",")
        : filters?.edge_type;
      return this.transport.request<PaginatedResult<Edge>>(
        "GET",
        path`/items/${sourceId}/edges`,
        {
          query: {
            ...(edgeType && { edge_type: edgeType }),
            ...(filters?.limit !== undefined && { limit: filters.limit }),
            ...(filters?.cursor && { cursor: filters.cursor }),
          },
        },
      );
    },

    /** Inbound edges — items where this id is target. */
    listToTarget: async (
      targetId: string,
      filters?: {
        edge_type?: string | string[];
        limit?: number;
        cursor?: string;
      },
    ): Promise<PaginatedResult<Edge>> => {
      const edgeType = Array.isArray(filters?.edge_type)
        ? filters.edge_type.join(",")
        : filters?.edge_type;
      return this.transport.request<PaginatedResult<Edge>>(
        "GET",
        path`/items/${targetId}/backrefs`,
        {
          query: {
            ...(edgeType && { edge_type: edgeType }),
            ...(filters?.limit !== undefined && { limit: filters.limit }),
            ...(filters?.cursor && { cursor: filters.cursor }),
          },
        },
      );
    },

    /** Every edge matching the filters, across as many pages as it takes. */
    listAll: (filters?: {
      edge_type?: string | string[];
      limit?: number;
    }): AsyncIterable<Edge> =>
      paginate((cursor) =>
        this.edges.list({ ...filters, ...(cursor ? { cursor } : {}) }),
      ),

    /** Every outbound edge from `sourceId`, across as many pages as it takes. */
    listAllFromSource: (
      sourceId: string,
      filters?: { edge_type?: string | string[]; limit?: number },
    ): AsyncIterable<Edge> =>
      paginate((cursor) =>
        this.edges.listFromSource(sourceId, {
          ...filters,
          ...(cursor ? { cursor } : {}),
        }),
      ),

    /** Every inbound edge targeting `targetId`, across as many pages as it takes. */
    listAllToTarget: (
      targetId: string,
      filters?: { edge_type?: string | string[]; limit?: number },
    ): AsyncIterable<Edge> =>
      paginate((cursor) =>
        this.edges.listToTarget(targetId, {
          ...filters,
          ...(cursor ? { cursor } : {}),
        }),
      ),

    /** Custom edge-type registration + listing. */
    types: {
      create: async (schema: EdgeTypeSchema): Promise<EdgeTypeSchema> => {
        const res = await this.transport.request<{
          edge_type: EdgeTypeSchema;
        }>("POST", "/edge-types", { body: schema });
        return res.edge_type;
      },
      list: async (): Promise<EdgeTypeSchema[]> => {
        const res = await this.transport.request<
          PaginatedResult<EdgeTypeSchema>
        >("GET", "/edge-types");
        return res.data;
      },
      delete: async (id: string): Promise<void> => {
        await this.transport.request<{ ok: true }>(
          "DELETE",
          path`/edge-types/${id}`,
        );
      },
    },
  };

  // ---- Blobs ----

  readonly blobs = {
    upload: async (
      data: Uint8Array | ArrayBuffer,
      mimeType: string,
    ): Promise<{ hash: string }> => {
      const response = await this.transport.rawRequest("POST", "/blobs", {
        rawBody: data,
        headers: { "Content-Type": mimeType },
      });

      const result = (await response.json()) as {
        hash: string;
        mime_type: string;
        size_bytes: number;
      };

      if (!response.ok) {
        this.throwRawError(response.status, result);
      }

      return { hash: result.hash };
    },

    download: async (hash: string): Promise<ArrayBuffer> => {
      const response = await this.transport.rawRequest(
        "GET",
        path`/blobs/${hash}`,
      );

      if (!response.ok) {
        const body: unknown = await response.json();
        this.throwRawError(response.status, body);
      }

      return response.arrayBuffer();
    },

    /** Check whether a blob exists without downloading it. */
    exists: async (hash: string): Promise<boolean> => {
      const cleanHash = hash.startsWith("sha256:") ? hash : `sha256:${hash}`;
      const response = await this.transport.rawRequest(
        "HEAD",
        path`/blobs/${cleanHash}`,
      );
      return response.status === 200;
    },

    /**
     * A time-limited link the bytes can be fetched from without a
     * credential: the object store's own signed link when one holds the
     * blob, otherwise one the instance serves. `ttlSeconds` asks for a
     * lifetime; the server caps it and `expires_in` reports what it gave.
     */
    url: async (
      hash: string,
      ttlSeconds?: number,
    ): Promise<{ url: string; expires_in: number }> => {
      const cleanHash = hash.startsWith("sha256:") ? hash : `sha256:${hash}`;
      const query =
        ttlSeconds === undefined ? "" : `?ttl=${String(ttlSeconds)}`;
      const response = await this.transport.rawRequest(
        "GET",
        path`/blobs/${cleanHash}/url` + query,
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        this.throwRawError(response.status, body);
      }
      return body as { url: string; expires_in: number };
    },
  };

  // ---- Types ----

  readonly types = {
    list: async (): Promise<TypeSchema[]> => {
      const res = await this.transport.request<PaginatedResult<TypeSchema>>(
        "GET",
        "/types",
      );
      return res.data;
    },

    get: async (id: string): Promise<TypeSchema> => {
      return this.transport.request<TypeSchema>("GET", path`/types/${id}`);
    },

    register: async (schema: TypeSchema): Promise<TypeSchema> => {
      const res = await this.transport.request<{ type: TypeSchema }>(
        "POST",
        "/types",
        { body: schema },
      );
      return res.type;
    },

    update: async (
      id: string,
      schema: Omit<TypeSchema, "id">,
    ): Promise<TypeSchema> => {
      const res = await this.transport.request<{ type: TypeSchema }>(
        "PUT",
        path`/types/${id}`,
        { body: schema },
      );
      return res.type;
    },

    delete: async (
      id: string,
      options?: { force?: boolean },
    ): Promise<void> => {
      const query = options?.force ? "?force=true" : "";
      await this.transport.request<{ ok: boolean }>(
        "DELETE",
        // The query stays outside the tag: it is a suffix, not a segment,
        // and escaping it would put `?force=true` inside the type name.
        path`/types/${id}` + query,
      );
    },
  };

  // ---- Keys ----

  readonly keys = {
    /** Creates an API key. The raw key value is returned exactly once on
     * creation; the rest of the shape mirrors the persisted ApiKey record
     * (source, default_tier, type_permissions, and
     * extension_permissions are all stamped at create time and visible
     * here so the caller doesn't need a follow-up GET /keys to inspect
     * them). */
    create: async (
      input: CreateKeyInput,
    ): Promise<ApiKey & { key: string }> => {
      return this.transport.request<ApiKey & { key: string }>("POST", "/keys", {
        body: input,
      });
    },

    list: async (): Promise<ApiKey[]> => {
      const res = await this.transport.request<PaginatedResult<ApiKey>>(
        "GET",
        "/keys",
      );
      return res.data;
    },

    /** Update mutable fields on an existing key (PATCH semantics —
     * omitted fields are left untouched). `source` is immutable after
     * creation and cannot be changed; the server rejects it with a 400. */
    update: async (id: string, input: UpdateKeyInput): Promise<ApiKey> => {
      return this.transport.request<ApiKey>("PATCH", path`/keys/${id}`, {
        body: input,
      });
    },

    /** Revoke a key. Not idempotent: a revoke that changes no row is
     * refused with a 404 `api_key_not_found`, so revoking a key twice, or
     * revoking an id that matches nothing, throws rather than resolving.
     * A caller retrying a revoke has to treat that 404 as the success it
     * is retrying after. */
    revoke: async (id: string): Promise<void> => {
      await this.transport.request<undefined>("DELETE", path`/keys/${id}`);
    },
  };

  // ---- Webhooks ----

  readonly webhooks = {
    create: async (input: CreateWebhookInput): Promise<Webhook> => {
      return this.transport.request<Webhook>("POST", "/webhooks", {
        body: input,
      });
    },

    list: async (): Promise<Webhook[]> => {
      const res = await this.transport.request<PaginatedResult<Webhook>>(
        "GET",
        "/webhooks",
      );
      return res.data;
    },

    get: async (id: string): Promise<Webhook> => {
      return this.transport.request<Webhook>("GET", path`/webhooks/${id}`);
    },

    update: async (id: string, input: UpdateWebhookInput): Promise<Webhook> => {
      return this.transport.request<Webhook>("PATCH", path`/webhooks/${id}`, {
        body: input,
      });
    },

    delete: async (id: string): Promise<void> => {
      await this.transport.request<{ ok: boolean }>(
        "DELETE",
        path`/webhooks/${id}`,
      );
    },

    deliveries: async (
      id: string,
      options?: { limit?: number },
    ): Promise<WebhookDelivery[]> => {
      const query = options?.limit ? { limit: String(options.limit) } : {};
      const res = await this.transport.request<
        PaginatedResult<WebhookDelivery>
      >("GET", path`/webhooks/${id}/deliveries`, { query });
      return res.data;
    },
  };

  // ---- Config ----

  /** Instance configuration. Carries the three optional schema-
   * enforcement levers (`strict_mode`, `source_allowlist`,
   * `source_filter`) and the cleanup-job overrides
   * (`audit_retention_days`, `event_log_retention_hours`,
   * `trash_retention_days`, `activity_retention_days`), under the
   * `instance_id` of the instance they belong to. Both endpoints take
   * `config.manage`. */
  readonly config = {
    /** Returns the instance config. Only `instance_id` when nothing is
     * configured. */
    get: async (): Promise<InstanceConfigResponse> => {
      return this.transport.request<InstanceConfigResponse>("GET", "/config");
    },

    /** Replaces the instance config (PUT semantics — full replacement, not
     * merge).
     *
     * Takes either a bare configuration or the whole document `get`
     * returned, and sends what it was given: `instance_id` sets nothing,
     * and one naming a different instance is refused `400`. Stripping it
     * here instead would turn a body addressed to the wrong host into a
     * success. */
    set: async (
      config: InstanceConfig | InstanceConfigResponse,
    ): Promise<InstanceConfigResponse> => {
      return this.transport.request<InstanceConfigResponse>("PUT", "/config", {
        body: config,
      });
    },
  };

  // ---- Admin ----

  /**
   * Operator maintenance. Every method requires the operator key
   * (`is_operator: true`). Every other credential gets a `403
   * forbidden`; render `"this command requires the operator key"`
   * in CLI / UI layers.
   */
  readonly admin = {
    platformTypes: {
      /**
       * Shipped type rows this instance still carries that the running
       * build no longer names, each with a live item count and the types
       * that inherit from it.
       *
       * A report rather than a prune: the shipped set is a committed
       * generated array, so a build cannot ship a partial one, and the
       * realistic population of a boot-time delete is a rollback, where
       * the older build simply does not know about rows the newer one
       * wrote. Removing is a separate, deliberate act.
       *
       * The route answers its whole set, so this returns the rows.
       */
      drift: async (): Promise<DriftedPlatformType[]> => {
        const res = await this.transport.request<
          PaginatedResult<DriftedPlatformType>
        >("GET", "/admin/platform-types/drift");
        return res.data;
      },

      /**
       * Remove exactly one platform type row this build no longer ships.
       * Irreversible and instance-wide: the row is deleted, and a build
       * that no longer ships the type cannot re-seed
       * it. The type keeps resolving until the next restart, because the
       * in-memory registry is filled from the rows at boot.
       *
       * Refused with `409` when the build still ships the identifier,
       * when items still carry it, or when another type declares it as
       * its parent; `404` when no platform row holds it.
       */
      remove: async (id: string): Promise<{ removed: true; id: string }> => {
        return this.transport.request<{ removed: true; id: string }>(
          "DELETE",
          path`/admin/platform-types/${id}`,
        );
      },
    },
  };

  /**
   * The change stream.
   *
   * Every write the caller can see arrives here as a full payload, so a client
   * that has applied an optimistic update locally can converge on the server's
   * version without refetching.
   */
  readonly events = {
    /**
     * Subscribe to `GET /events`.
     *
     * Persist `subscription.lastEventId` and pass it back as
     * `options.lastEventId` to resume across restarts. Handle
     * `onCatchupTooOld`: it means the cursor has aged out of the retention
     * window, and the only correct response is to re-read state and subscribe
     * again from nothing.
     */
    subscribe: (options: SubscribeOptions): Subscription => {
      return subscribeToEvents(this.transport, options);
    },
  };

  // ---- Occurrences ----

  /**
   * The calendar read: which events actually fall inside a stretch of
   * time. A recurring series is stored as one item carrying its rule, so
   * `client.items.list` answers "what is on next Tuesday" with the first
   * occurrence and nothing else. This expands the rules instead, and lets
   * a stored exception stand in for the occurrence it replaced.
   */
  readonly occurrences = {
    /**
     * `GET /occurrences`.
     *
     * Returns the envelope rather than a bare array, because
     * `series_errors` is part of the answer: a calendar quietly missing a
     * weekly meeting is the failure nobody sees. One page always: the window
     * is the bound, and a window needing pages is one the server refuses.
     *
     * The window is required and capped at both ends, and the caps are
     * the server's to apply: a span past its limit and a result past its
     * ceiling are both refused rather than trimmed, arriving as
     * `ValidationError` carrying the server's own `max_days` /
     * `max_occurrences` in `details`. The occurrence refusal carries
     * `found` beside `max_occurrences`, and — when expansion had already
     * been truncated before the ceiling was crossed —
     * `expansion_incomplete` and `series_unexpanded` as well. Branch on
     * those two in the `catch`: the refusal says to narrow the window,
     * and they say that narrowing it returns a calendar that is partial
     * for a second reason. Nothing is pre-checked here. A
     * second copy of those constants would start refusing what the server
     * would happily serve the day either one moved, and it could only
     * ever cover the span — the occurrence ceiling depends on the data,
     * so half the refusals would still need the round trip and a caller
     * could not tell the two apart.
     *
     * There is no third refusal. `series_errors` is capped rather than
     * refused past `scan.max_series_errors`, because that list is a
     * diagnostic beside the calendar and nothing in `data` depends on it
     * — the healthy series still expand and return. A
     * capped list sets `series_errors_truncated` and
     * `scan.series_errors` keeps the true count, so a partial list is
     * never mistaken for a complete one. That count is scoped to the
     * event types this read covered, so it is a statement about what was
     * read and not about the instance: pass a `type`, or use a credential
     * permissioned for one event type, and the rules of the other type
     * are neither read nor counted.
     *
     * There is no refusal for the size of the calendar itself either.
     * The passes that gather series and exceptions cannot be windowed —
     * a rule written years ago produces occurrences in any window, and
     * an exception moved out of one still shadows the slot it left — so
     * both read the instance whole however little is asked for, and a large
     * calendar is read slowly rather than refused. `scan` on the result
     * is where that cost is visible: `events_read` grows with the
     * calendar rather than with the window, and `max_occurrences`
     * arrives on every success, so a calendar approaching the one
     * data-dependent ceiling that does refuse can be seen coming rather
     * than met as a 400.
     *
     * What "slowly" is bounded by is the expansion budget, and it is the
     * one place the calendar can come back partial. A read spends at
     * most `scan.max_unproductive_iterations` walking rules that produce
     * no occurrence, and an instance holding enough of them — per-minute
     * reminders, or a long history of series that have ended — reaches
     * that before it reaches every series. Such a read succeeds with
     * `expansion_incomplete` set and `scan.series_unexpanded` above
     * zero, which is worth branching on: it is the difference between a
     * calendar and most of one.
     */
    list: async (
      options: ListOccurrencesOptions,
    ): Promise<OccurrencesResult> => {
      return this.transport.request<OccurrencesResult>("GET", "/occurrences", {
        query: {
          from: this.windowBound(options.from, "from"),
          to: this.windowBound(options.to, "to"),
          type: options.type,
        },
      });
    },
  };

  // ---- Internal ----

  /**
   * One end of an occurrences window, as the server wants to read it.
   *
   * A `Date` is convenient to pass and lossless to send, being an instant
   * already. An unparseable one is not: `toISOString()` answers a
   * `RangeError`, which would be the single refusal from this namespace
   * that is not a `MarfaError`. A string goes through untouched, leaving
   * the server the only judge of what it will accept.
   *
   * The refusal carries its own code and a zero status, because no server
   * saw it: `validation_error` and 400 both name a rejection that never
   * happened.
   */
  private windowBound(value: string | Date, field: string): string {
    if (typeof value === "string") return value;
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError(
        `${field} is not a usable Date`,
        { [field]: String(value) },
        "invalid_window_bound",
        0,
      );
    }
    return value.toISOString();
  }

  private throwRawError(status: number, body: unknown): never {
    const parsed = body as Partial<ErrorResponse> | null;
    const errObj = parsed?.error;
    const message = errObj?.message ?? `HTTP ${String(status)}`;
    const details = errObj?.details;

    switch (status) {
      case 400:
        throw new ValidationError(message, details);
      case 401:
        throw new UnauthorizedError(message, details);
      case 403:
        throw new ForbiddenError(message, details);
      case 404:
        throw new NotFoundError(message, details);
      default:
        throw new MarfaError(
          errObj?.code ?? "unknown",
          message,
          status,
          details,
        );
    }
  }
}
