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
  TenantConfig,
  TenantQuota,
  Tenant,
  TenantMetrics,
  TenantActivityEntry,
  Edge,
  CreateEdgeInput,
  EdgeTypeSchema,
  Profile,
  UpdateProfileInput,
} from "@withmarfa/shared";
import type {
  TypeSchema,
  ErrorResponse,
  Webhook,
  WebhookDelivery,
  CreateWebhookInput,
  UpdateWebhookInput,
  ConnectionInstallResult,
  ConnectionUninstallResult,
  PreviewEventRequest,
  PreviewEventResult,
} from "@withmarfa/shared";
import { generateId } from "@withmarfa/shared";
import { HttpTransport } from "./transport.js";
import {
  BulkJobCancelledError,
  BulkJobFailedError,
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

// ---------------------------------------------------------------------------
// Config and option types
// ---------------------------------------------------------------------------

/** Minimal token provider shape — full interface lives in
 *  @withmarfa/sdk/auth. Kept loose here so the data root doesn't depend
 *  on the auth subpath. */
interface TokenProviderLike {
  getAccessToken(): Promise<string>;
}

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
  cdnBaseUrl?: string;
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
  /** Toggle the tier (`library` ↔ `feed`). Independent of the version-merge
   *  path for `properties`; a tier-only update never conflicts. */
  tier?: Tier;
  /**
   * Repoint the item at a new natural-key identifier under the caller's
   * stamped `source`. The server enforces `(source, source_id)` uniqueness
   * per tenant — a collision returns HTTP 409 `source_id_conflict`. PATCHing
   * the value the item already carries is a no-op success. Used by the
   * sync agent (T-118) to preserve item identity through file renames.
   */
  source_id?: string;
  /**
   * Item type. Required by the `auto` strategy when a `keep_both_copies`
   * conflict spawns a sibling item. Omit to let the SDK pre-fetch it —
   * when `expectedVersion` is also omitted the pre-fetch happens upfront;
   * when `expectedVersion` is provided the fetch is deferred until a
   * `keep_both_copies` conflict actually needs it.
   */
  type?: string;
  /**
   * Listener invoked after the auto-merge path completes successfully.
   * Overrides the client's default `onConflictAutoMerge` for this call.
   */
  onAutoMerge?: ConflictAutoMergeListener;
}

export interface ListFilters {
  type?: string;
  state?: ItemState;
  source?: string;
  /** Tier filter. `"library"` restricts to library items; `"feed"` restricts
   * to feed items; `"all"` (or omitting the field) returns both. */
  tier?: Tier | "all";
  tags?: string[];
  /** Filter-language expression, e.g. `edge[parent-of] eq "<id>"` or
   *  `edge[parent-of] not_exists`. The filter language replaces the
   *  previously-exposed `parent_id` and `root_only` convenience params. */
  filter?: string;
  sort?: "created_at" | "updated_at" | "timestamp";
  direction?: "asc" | "desc";
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  /**
   * Opt-in hydrations on the list response. Comma-separated values; each
   * value widens the per-item shape. Prefer the typed helpers
   * (`listWithMetadata`, `listWithExtensions`) over raw strings.
   *
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

/** Item paired with its hydrated extension namespaces. */
export type ItemWithExtensions = Item & {
  extensions: Record<string, Record<string, unknown>>;
};

export interface SearchFilters {
  type?: string;
  state?: ItemState;
  /** Tier filter, matching `ListFilters.tier`. */
  tier?: Tier | "all";
  /** Items must have ALL specified tags (AND semantics). Matches
   *  `ListFilters.tags` and `/items?tags=`. */
  tags?: string[];
  filter?: string;
  limit?: number;
}

export interface MetadataInput {
  tags?: string[];
}

/**
 * Compact API-key summary returned by the admin keys-list route
 * (T-117). The full `ApiKey` shape carries permission maps; the
 * operator surface deliberately surfaces only the identifying fields +
 * timestamps needed for emergency revocation.
 */
export interface TenantApiKeySummary {
  id: string;
  label: string;
  source: string;
  role: string;
  is_platform: boolean;
  created_at: string;
  last_used_at: string | null;
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
  timestamp?: string;
  /** Ignored on the wire — server stamps `source` from the credential.
   *  Kept on the input shape for round-trip parity with /export output. */
  source?: string;
  source_id?: string;
  origin?: "user" | "ai" | "worker";
  device?: string;
  tags?: string[];
  /** Outbound edges to reconcile in the same transaction as the item
   *  write. Replace-all semantics per edge_type. Absent = untouched. */
  edges?: Record<string, string[]>;
}

export type BulkMode = "upsert" | "create_only";

/**
 * Input to `client.items.createWithAttachments(...)` (T-100). Wraps the
 * existing blob-upload + `items.bulk` pattern: upload each attachment's
 * blob, then issue one atomic bulk call containing the host item and the
 * `core.file.*` items with inline `attached-to` edges from each
 * attachment back to the host.
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
   *  `"attached-to"` (the canonical attachment edge — T-108). Override
   *  for app-specific semantics like `"cover-image"`. */
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
  /** Default: `false`. Per-item events are suppressed on bulk writes
   *  unless the caller opts in. */
  emit_events?: boolean;
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
  /** Default: `false`. Per-edge `edge.created` / `edge.deleted` webhook
   *  events are suppressed on bulk writes unless the caller opts in. */
  emit_events?: boolean;
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

/** Filter shape for `POST /items/bulk-actions`. Mirrors the `GET /items`
 *  query grammar — every field is AND-composed, `filter` accepts the
 *  full filter-SQL DSL. */
export interface BulkActionFilter {
  type?: string;
  state?: ItemState;
  source?: string;
  tier?: Tier | "all";
  tags?: string[];
  since?: string;
  until?: string;
  /** Same grammar as `GET /items?filter=`. `edge[type]=id` shorthand
   *  becomes `edge[type] eq "id"` here. */
  filter?: string;
}

/** Shared knobs every bulk action accepts. */
interface BulkActionBase {
  filter?: BulkActionFilter;
  dry_run?: boolean;
  max_items?: number;
  emit_events?: boolean;
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
  | (BulkActionBase & { action: "update_timestamp"; timestamp: string });

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
  /** Unique blob hashes referenced by items in a `purge` action. Not a
   *  strict orphan count — callers that need that should wait for blob
   *  GC to land. Omitted for non-purge actions. */
  blob_hashes_referenced?: number;
}

/** Terminal vs non-terminal lifecycle states for a `bulk_action` job.
 *  Terminal values (`completed`, `failed`, `cancelled`) freeze the row;
 *  the worker only mutates `queued` → `in_progress` → terminal. */
export type BulkActionJobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

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
   *  absent on `cancelled` (whole-or-nothing — partial counts live on
   *  the envelope's `processed`/`succeeded`/`errored` fields). */
  result?: BulkActionResult;
}

// ---------------------------------------------------------------------------
// Secure storage protocol — parallel to the Swift SDK's `SecureStorage`.
// TS's runtime is heterogeneous (Node, Deno, browser), so the SDK does
// not bundle a concrete backend; callers wire up file-backed, OS
// keyring, or in-memory implementations as their environment demands.
// ---------------------------------------------------------------------------

/** Minimal contract for the credential store consumed by
 *  `MarfaClient.fromSecureStorage()`. Implementations need only support
 *  `get(account)`; richer operations belong to the implementing module. */
export interface SecureStorage {
  /** Returns the stored API key for `account`, or `null` when absent. */
  get(account: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MarfaClient {
  private readonly transport: HttpTransport;
  private readonly defaultConflictStrategy: ConflictStrategy;
  private readonly defaultOnConflictAutoMerge?: ConflictAutoMergeListener;
  private readonly apiBaseUrl: string;
  private readonly cdnBaseUrl?: string;

  constructor(config: ClientConfig) {
    this.apiBaseUrl = config.url.replace(/\/+$/, "");
    this.transport = new HttpTransport({
      baseUrl: config.url,
      apiKey: config.apiKey,
      tokenProvider: config.tokenProvider,
      fetch: config.fetch,
      timeoutMs: config.timeoutMs,
    });
    this.defaultConflictStrategy = config.conflictStrategy ?? "auto";
    this.defaultOnConflictAutoMerge = config.onConflictAutoMerge;
    this.cdnBaseUrl = config.cdnBaseUrl;
  }

  // -------------------------------------------------------------------------
  // Static factories — parity with the Swift SDK's
  // `MarfaClient.fromEnvironment()` / `.fromSecureStorage()`.
  // -------------------------------------------------------------------------

  /**
   * Builds a client from process environment variables.
   *
   * Reads `MARFA_API_URL` and `MARFA_API_KEY` from `globalThis.process.env`.
   * Returns `null` if either is missing or empty, or if `process` is not
   * available (e.g. browser context with no shim) — callers decide how to
   * fall back.
   *
   * Mirrors the Swift SDK's `MarfaClient.fromEnvironment()` shape.
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
   * backend. Mirrors the Swift SDK's `MarfaClient.fromSecureStorage()` —
   * the secret-storage abstraction is protocol-only, so callers can plug
   * in a file-backed store, an OS keyring binding, or an in-memory mock.
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
    ): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "POST",
        "/items",
        { body: input },
      );
      return res.item;
    },

    /**
     * Create-or-update an item, surfacing whether the server resolved as a
     * fresh create (HTTP 201) or a natural-key match update (HTTP 200).
     *
     * `POST /items` accepts a `(source, source_id)` pair as a stable
     * natural key (T-038): a second POST with the same pair updates the
     * existing row in place rather than 409ing. The wire shape returned
     * is `{ item }` regardless — the only signal of "created vs updated"
     * is the HTTP status code, which `transport.request` consumes
     * internally. This method threads the status out so callers can
     * surface the distinction (e.g. CLI `Created.` vs `Updated
     * (natural-key match).`).
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
        `/items/${id}`,
      );
      return res.item;
    },

    list: async (filters?: ListFilters): Promise<PaginatedResult<Item>> => {
      return this.transport.request<PaginatedResult<Item>>("GET", "/items", {
        query: filters,
      });
    },

    listWithMetadata: async (
      filters?: Omit<ListFilters, "include">,
    ): Promise<PaginatedResult<ItemWithMetadata>> => {
      return this.transport.request<PaginatedResult<ItemWithMetadata>>(
        "GET",
        "/items",
        {
          query: {
            ...filters,
            include: "metadata",
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
      filters?: Omit<ListFilters, "include">,
    ): Promise<PaginatedResult<ItemWithExtensions>> => {
      return this.transport.request<PaginatedResult<ItemWithExtensions>>(
        "GET",
        "/items",
        {
          query: {
            ...filters,
            include: "extensions",
          },
        },
      );
    },

    update: async (
      id: string,
      properties: Record<string, unknown>,
      options?: UpdateOptions,
    ): Promise<Item> => {
      // Skip the upfront GET when the caller has supplied an expected
      // version. `type` stays optional — the conflict handler lazy-fetches
      // it only if a `keep_both_copies` path needs to spawn a sibling item.
      const expected = options?.expectedVersion;
      let version: number;
      let type: string | undefined = options?.type;
      if (expected !== undefined) {
        version = expected;
      } else {
        const item = await this.items.get(id);
        version = item.version;
        type ??= item.type;
      }

      const strategy = options?.conflict ?? this.defaultConflictStrategy;
      const onAutoMerge =
        options?.onAutoMerge ?? this.defaultOnConflictAutoMerge;

      return handleConflictUpdate(
        this.transport,
        id,
        type,
        properties,
        version,
        strategy,
        options?.resolve,
        options?.tier,
        onAutoMerge,
        options?.source_id,
      );
    },

    delete: async (id: string): Promise<void> => {
      await this.transport.request<undefined>("DELETE", `/items/${id}`);
    },

    /** Permanently delete a trashed item (admin only). Item must already
     * be in state "trashed"; returns 400 otherwise. Irreversible. */
    purge: async (id: string): Promise<void> => {
      await this.transport.request<{ ok: true }>(
        "DELETE",
        `/items/${id}/purge`,
      );
    },

    restore: async (id: string): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "POST",
        `/items/${id}/restore`,
      );
      return res.item;
    },

    transition: async (id: string, state: string): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "POST",
        `/items/${id}/transition`,
        { body: { state } },
      );
      return res.item;
    },

    versions: async (id: string): Promise<Version[]> => {
      const res = await this.transport.request<{ versions: Version[] }>(
        "GET",
        `/items/${id}/versions`,
      );
      return res.versions;
    },

    stats: async (): Promise<Record<string, number>> => {
      return this.transport.request<Record<string, number>>(
        "GET",
        "/items/stats",
      );
    },

    /**
     * Create or upsert many items in one call (admin-only). Replaces the
     * historical `/import` endpoint. Up to 5000 items per call.
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
     * one call (T-100). Wraps the existing `blobs.upload` + `items.bulk`
     * primitives: each attachment's blob is uploaded concurrently, then a
     * single atomic bulk call writes the host and the attachments
     * together with inline `attached-to` edges from each attachment back
     * to the host (matching T-108's spec direction).
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

      // Upload blobs concurrently. Promise.all surfaces the first
      // rejection; we rewrap so the operator sees which attachment
      // failed (the original error becomes the cause).
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

      // Build the bulk payload. Host first (caller's input passed
      // through), then each attachment with auto blob_ref / mime_type
      // and the `attached-to` edge pointing at the host id.
      const hostBulkItem: BulkItemInput = {
        ...input.item,
        id: hostId,
      };

      const attachmentIds: string[] = [];
      const attachmentBulkItems: BulkItemInput[] = input.attachments.map(
        (att, idx) => {
          const attachmentId = att.id ?? generateId();
          attachmentIds.push(attachmentId);
          // Promise.all preserves index ↔ result ordering, so uploadResults[idx]
          // is guaranteed populated when we reach this point.
          const upload = uploadResults[idx];
          if (!upload) {
            throw new MarfaError(
              "internal_error",
              `createWithAttachments: upload result missing for attachments[${String(idx)}]`,
              500,
            );
          }

          // Merge caller-supplied edges with the helper's `attached-to`
          // (or whatever `edgeType` resolves to). Additive on collision:
          // host id is appended rather than overwriting.
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

      // Distil the bulk result into typed { host, attachments } using
      // the minted ids as the join key. Bulk returns one entry per input
      // item; on the atomic happy path every outcome is `"created"`.
      // Errored AND skipped entries surface as a MarfaError — the helper
      // guarantees a fresh create on every call, so any non-created
      // outcome (typically a `create_only` collision on a caller-supplied
      // `input.item.id`) is a programming error rather than success.
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

      // Hydrate the items via individual reads — `items.bulk` returns
      // `BulkResultEntry { id, outcome }`, not the full `Item`. One round
      // trip per item; acceptable for the typical attachment-count
      // (1–5) and avoids needing a second wire endpoint. Concurrent.
      const hydrated = await Promise.all(
        [hostId, ...attachmentIds].map((id) => this.items.get(id)),
      );
      const [host, ...attachments] = hydrated;
      if (!host) {
        throw new MarfaError(
          "internal_error",
          "createWithAttachments: host hydration returned no item",
          500,
        );
      }

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
      // T-218: the server returns 200 for dry-run (synchronous) and
      // 202 + a BulkActionJob envelope for everything else. The default
      // shape of `bulkAction()` keeps callers blissfully unaware — poll
      // internally and resolve with the same BulkActionResult shape
      // they got before the async refactor.
      const { data, status } = await this.transport.requestWithStatus<
        BulkActionResult | BulkActionJob
      >("POST", "/items/bulk-actions", { body: input });
      if (status === 200) {
        // dry_run path stayed synchronous; the response IS the result.
        return data as BulkActionResult;
      }
      const queued = data as BulkActionJob;
      const final = await pollUntilTerminal({
        fetchOnce: () => this.items.bulkActionStatus(queued.id),
        isTerminal: (job) =>
          job.status === "completed" ||
          job.status === "failed" ||
          job.status === "cancelled",
        onProgress: options?.onProgress,
        pollIntervalMs: options?.pollIntervalMs,
        maxPollIntervalMs: options?.maxPollIntervalMs,
        maxWaitMs: options?.maxWaitMs,
      });
      if (final.status === "cancelled") {
        throw new BulkJobCancelledError({
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
     * T-218: low-level companion to `bulkAction()`. Fires the POST and
     * returns the initial job envelope without polling. Callers wanting
     * explicit control over the lifecycle (a UI that wants to surface
     * progress directly, an LLM tool returning the job id, etc.) drive
     * polling themselves via `bulkActionStatus`. Dry-run requests are
     * still synchronous on the server; this method throws with a
     * descriptive error if `dry_run: true` is set so callers don't
     * silently lose their result.
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
      // Server returns 202 for the async path; defensive check.
      if (status !== 202) {
        throw new MarfaError(
          "internal_error",
          `Expected 202 from bulk_action async path, got ${String(status)}`,
          status,
        );
      }
      return data;
    },

    /** T-218: poll a bulk_action job by id. Single GET — no polling. */
    bulkActionStatus: (jobId: string): Promise<BulkActionJob> =>
      this.transport.request<BulkActionJob>(
        "GET",
        `/items/bulk-actions/jobs/${encodeURIComponent(jobId)}`,
        { timeoutMs: 5_000 },
      ),

    /** T-218: request cancellation of a bulk_action job. Idempotent —
     *  already-terminal jobs return their existing state unchanged. */
    bulkActionCancel: (jobId: string): Promise<BulkActionJob> =>
      this.transport.request<BulkActionJob>(
        "DELETE",
        `/items/bulk-actions/jobs/${encodeURIComponent(jobId)}`,
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
        `/items/${itemId}/metadata`,
      );
      return res.metadata;
    },

    set: async (itemId: string, input: MetadataInput): Promise<Metadata> => {
      const res = await this.transport.request<{ metadata: Metadata }>(
        "PUT",
        `/items/${itemId}/metadata`,
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
        `/items/${itemId}/metadata`,
        { body: input },
      );
      return res.metadata;
    },

    addTags: async (itemId: string, tags: string[]): Promise<Metadata> => {
      const res = await this.transport.request<{ metadata: Metadata }>(
        "POST",
        `/items/${itemId}/tags`,
        { body: { tags } },
      );
      return res.metadata;
    },

    removeTag: async (itemId: string, tag: string): Promise<void> => {
      await this.transport.request<{ metadata: Metadata }>(
        "DELETE",
        `/items/${itemId}/tags/${encodeURIComponent(tag)}`,
      );
    },

    /**
     * Enumerate the distinct set of tags in use across items the caller can
     * read. Tenant-scoped, type-permission scoped, excludes trashed items.
     * Returns tags with usage counts, sorted by count desc then tag asc.
     */
    listTags: async (): Promise<{ tag: string; count: number }[]> => {
      const res = await this.transport.request<{
        tags: { tag: string; count: number }[];
      }>("GET", "/metadata/tags");
      return res.tags;
    },

    getExtensions: async (
      itemId: string,
      namespace?: string,
    ): Promise<Record<string, Record<string, unknown>>> => {
      if (namespace) {
        const res = await this.transport.request<{
          namespace: string;
          data: Record<string, unknown> | null;
        }>(
          "GET",
          `/items/${itemId}/extensions/${encodeURIComponent(namespace)}`,
        );
        return res.data ? { [namespace]: res.data } : {};
      }
      const res = await this.transport.request<{
        extensions: Record<string, Record<string, unknown>>;
      }>("GET", `/items/${itemId}/extensions`);
      return res.extensions;
    },

    setExtension: async (
      itemId: string,
      namespace: string,
      data: Record<string, unknown>,
    ): Promise<Record<string, Record<string, unknown>>> => {
      const res = await this.transport.request<{
        extensions: Record<string, Record<string, unknown>>;
      }>(
        "PUT",
        `/items/${itemId}/extensions/${encodeURIComponent(namespace)}`,
        { body: data },
      );
      return res.extensions;
    },

    deleteExtension: async (
      itemId: string,
      namespace: string,
    ): Promise<void> => {
      await this.transport.request(
        "DELETE",
        `/items/${itemId}/extensions/${encodeURIComponent(namespace)}`,
      );
    },
  };

  // ---- Search ----

  async search(
    query: string,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    const res = await this.transport.request<{ results: SearchResult[] }>(
      "GET",
      "/search",
      { query: { q: query, ...filters } },
    );
    return res.results;
  }

  // ---- Edges ----

  readonly edges = {
    /**
     * Global edge listing across the tenant, filtered by edge type
     * (comma-separated string or array of type ids). Use this when you
     * need "all edges of type X" — replaces the walk-every-item
     * pattern. Per-target filters live on `listFromSource` /
     * `listToTarget`.
     */
    list: async (filters?: {
      edge_type?: string | string[];
      limit?: number;
      cursor?: string;
    }): Promise<PaginatedResult<Edge>> => {
      const edgeType = Array.isArray(filters?.edge_type)
        ? filters.edge_type.join(",")
        : filters?.edge_type;
      return this.transport.request<PaginatedResult<Edge>>("GET", "/edges", {
        query: {
          ...(edgeType && { edge_type: edgeType }),
          ...(filters?.limit !== undefined && { limit: filters.limit }),
          ...(filters?.cursor && { cursor: filters.cursor }),
        },
      });
    },

    /** Create a single edge. Server enforces cardinality / type
     *  constraints / cycle prevention; throws on violation. */
    create: async (input: CreateEdgeInput): Promise<Edge> => {
      const res = await this.transport.request<{ edge: Edge }>(
        "POST",
        "/edges",
        { body: input },
      );
      return res.edge;
    },

    /** Update properties on an existing edge. edge_type / source / target
     *  are immutable; server rejects with 400. */
    update: async (
      id: string,
      properties: Record<string, unknown>,
    ): Promise<Edge> => {
      const res = await this.transport.request<{ edge: Edge }>(
        "PATCH",
        `/edges/${id}`,
        { body: { properties } },
      );
      return res.edge;
    },

    delete: async (id: string): Promise<void> => {
      await this.transport.request<{ ok: true }>("DELETE", `/edges/${id}`);
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
     * Sibling to `items.bulk` for the edges half of mode-transition
     * migrations (where cross-item edges can't reliably ride along as
     * inline-edge payloads on the item writes).
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
        `/items/${sourceId}/edges`,
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
        `/items/${targetId}/backrefs`,
        {
          query: {
            ...(edgeType && { edge_type: edgeType }),
            ...(filters?.limit !== undefined && { limit: filters.limit }),
            ...(filters?.cursor && { cursor: filters.cursor }),
          },
        },
      );
    },

    /** Custom edge-type registration + listing. */
    types: {
      create: async (schema: EdgeTypeSchema): Promise<EdgeTypeSchema> => {
        const res = await this.transport.request<{
          edge_type: EdgeTypeSchema;
        }>("POST", "/edge-types", { body: schema });
        return res.edge_type;
      },
      list: async (): Promise<EdgeTypeSchema[]> => {
        const res = await this.transport.request<{
          edge_types: EdgeTypeSchema[];
        }>("GET", "/edge-types");
        return res.edge_types;
      },
      delete: async (id: string): Promise<void> => {
        await this.transport.request<{ ok: true }>(
          "DELETE",
          `/edge-types/${id}`,
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
        size: number;
      };

      if (!response.ok) {
        this.throwRawError(response.status, result);
      }

      return { hash: result.hash };
    },

    download: async (hash: string): Promise<ArrayBuffer> => {
      const response = await this.transport.rawRequest("GET", `/blobs/${hash}`);

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
        `/blobs/${cleanHash}`,
      );
      return response.status === 200;
    },

    /** Returns a direct CDN URL if configured, otherwise the API proxy URL. */
    url: (hash: string): string => {
      const cleanHash = hash.startsWith("sha256:") ? hash : `sha256:${hash}`;
      if (this.cdnBaseUrl) {
        return `${this.cdnBaseUrl}/blobs/${cleanHash}`;
      }
      return `${this.apiBaseUrl}/blobs/${cleanHash}`;
    },
  };

  // ---- Types ----

  readonly types = {
    list: async (): Promise<TypeSchema[]> => {
      return this.transport.request<TypeSchema[]>("GET", "/types");
    },

    get: async (id: string): Promise<TypeSchema> => {
      return this.transport.request<TypeSchema>("GET", `/types/${id}`);
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
        `/types/${id}`,
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
        `/types/${id}${query}`,
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
      const res = await this.transport.request<{ keys: ApiKey[] }>(
        "GET",
        "/keys",
      );
      return res.keys;
    },

    /** Update mutable fields on an existing key (PATCH semantics —
     * omitted fields are left untouched). `source` and `role` are
     * immutable after creation and cannot be changed; the server rejects
     * them with a 400. */
    update: async (id: string, input: UpdateKeyInput): Promise<ApiKey> => {
      return this.transport.request<ApiKey>("PATCH", `/keys/${id}`, {
        body: input,
      });
    },

    revoke: async (id: string): Promise<void> => {
      await this.transport.request<undefined>("DELETE", `/keys/${id}`);
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
      const res = await this.transport.request<{ webhooks: Webhook[] }>(
        "GET",
        "/webhooks",
      );
      return res.webhooks;
    },

    get: async (id: string): Promise<Webhook> => {
      return this.transport.request<Webhook>("GET", `/webhooks/${id}`);
    },

    update: async (id: string, input: UpdateWebhookInput): Promise<Webhook> => {
      return this.transport.request<Webhook>("PATCH", `/webhooks/${id}`, {
        body: input,
      });
    },

    delete: async (id: string): Promise<void> => {
      await this.transport.request<{ ok: boolean }>(
        "DELETE",
        `/webhooks/${id}`,
      );
    },

    deliveries: async (
      id: string,
      options?: { limit?: number },
    ): Promise<WebhookDelivery[]> => {
      const query = options?.limit ? { limit: String(options.limit) } : {};
      const res = await this.transport.request<{
        deliveries: WebhookDelivery[];
      }>("GET", `/webhooks/${id}/deliveries`, { query });
      return res.deliveries;
    },
  };

  // ---- Connections ----

  /**
   * Connection management. The `system.connection` items themselves are
   * still managed via `client.items` (list, get, transition); this
   * namespace adds the orchestrated lifecycle operations that don't fit
   * the generic items surface — specifically `uninstall`, which requires
   * a multi-step server-side teardown across credentials, tokens, and
   * inbound subscriptions.
   *
   * Convenience filters for listing connections (by `integration_ref`,
   * `state`, etc.) live on `client.items.list({ type: "system.connection",
   * ... })`. The CLI's `my connections` tree wraps both.
   */
  readonly connections = {
    /**
     * JSON install of an Integration manifest — server-side sibling of
     * the browser consent flow at `POST /integrations/:id/install`.
     * Skips the HTML consent screen so operators and tooling can install
     * connections non-interactively. Admin-only; tenant admins install
     * into their own tenant scope.
     *
     * `integration_id` references a `system.integration` item (registered
     * via `POST /integrations`). `label` is optional — the server
     * defaults to `${manifest_name} ${manifest_version}` when omitted.
     * Returns the new connection id, the seed runtime credential id,
     * and the `system.activity` row id from the install pipeline.
     */
    install: async (input: {
      integration_id: string;
      label?: string;
    }): Promise<ConnectionInstallResult> => {
      return this.transport.request<ConnectionInstallResult>(
        "POST",
        "/connections/install",
        { body: input },
      );
    },
    /**
     * Orchestrated uninstall of an `integration`
     * connection. Revokes runtime credentials, deletes upstream OAuth
     * tokens, revokes active leased tokens, disables inbound webhook
     * subscriptions, transitions the system.connection state to
     * `revoked`, and emits a `system.activity` row. Audit-logged.
     *
     * Idempotent at the artefact level — revoking already-revoked
     * tokens is a no-op — but rejects with 400 when the connection
     * itself is already in state `revoked`. Admin-only; tenant admins
     * can uninstall connections in their own tenant scope.
     */
    uninstall: async (id: string): Promise<ConnectionUninstallResult> => {
      return this.transport.request<ConnectionUninstallResult>(
        "POST",
        `/connections/${id}/uninstall`,
      );
    },
    /**
     * Preview the wire envelopes the reactive-run bridge would emit for
     * a synthetic item-event, without dispatching anything. Operator
     * debugging surface (T-083): given an existing item id and an event
     * type, the route returns one row per subscribing connection — either
     * `would_dispatch: true` with the synthesised envelope, or
     * `would_dispatch: false` with a `dispatch_reason` (`self_event`,
     * `cross_tenant`, `hop_budget_exceeded`, `subscription_inactive`).
     *
     * Defaults to all subscribers in the caller's tenant; pass
     * `connection_id` to filter to one. The optional `cycle` override
     * lets you reproduce reactive scenarios ("what if hop_count was N?").
     * Tenant-admin only.
     */
    previewEvent: async (
      input: PreviewEventRequest,
    ): Promise<PreviewEventResult> => {
      return this.transport.request<PreviewEventResult>(
        "POST",
        "/connections/preview-event",
        { body: input },
      );
    },
  };

  // ---- Tenants (admin) ----

  /** Tenant-scoped configuration. Carries the three optional schema-
   * enforcement levers (TSC42 §5: `strict_mode`, `source_allowlist`,
   * `source_filter`) and the per-tenant cleanup-job overrides
   * (`audit_retention_days`, `event_log_retention_hours`,
   * `trash_retention_days`). All endpoints are admin-only. */
  readonly tenants = {
    /** Returns the current tenant's config. Empty object when nothing
     * is configured. */
    getConfig: async (): Promise<TenantConfig> => {
      return this.transport.request<TenantConfig>("GET", "/tenants/me/config");
    },

    /** Replaces the current tenant's config (PUT semantics — full
     * replacement, not merge). */
    setConfig: async (config: TenantConfig): Promise<TenantConfig> => {
      return this.transport.request<TenantConfig>("PUT", "/tenants/me/config", {
        body: config,
      });
    },

    /** Per-tenant resource quotas (T-052). Empty / missing limits fall
     *  back to the instance defaults from env. Quotas are platform-
     *  admin-managed. */
    quotas: {
      /**
       * Read the calling tenant's quota row. Resolves the tenant from
       * the bearer's `tenant_id`; rejects with 400 when the credential
       * is tenant-less (platform admin, single-tenant self-host
       * bootstrap). Use `getById` instead in that case.
       *
       * Wave B Part 4 follow-on: ships alongside T-015's release tag.
       * The route landed in Wave B Part 2 (`GET /tenants/me/quotas`)
       * and was usable via raw HTTP until this method.
       */
      getOwn: async (): Promise<TenantQuota> => {
        return this.transport.request<TenantQuota>("GET", "/tenants/me/quotas");
      },

      /** Read a specific tenant's quota row (platform admin only). */
      getById: async (tenantId: string): Promise<TenantQuota> => {
        return this.transport.request<TenantQuota>(
          "GET",
          `/tenants/${encodeURIComponent(tenantId)}/quotas`,
        );
      },

      /** Replace a tenant's quota row (platform admin only). Pass null
       *  on a field to clear it (revert to env default). */
      set: async (
        tenantId: string,
        input: {
          items_limit?: number | null;
          webhooks_limit?: number | null;
          blobs_limit?: number | null;
          storage_bytes_limit?: number | null;
          rate_per_minute_limit?: number | null;
        },
      ): Promise<TenantQuota> => {
        return this.transport.request<TenantQuota>(
          "PUT",
          `/tenants/${encodeURIComponent(tenantId)}/quotas`,
          { body: input },
        );
      },
    },
  };

  // ---- Admin (T-117) ----

  /**
   * Operator-level admin surface — the `my admin` CLI command tree's
   * backing endpoints. Every method requires a platform-admin key
   * (`is_platform: true`). Non-platform credentials get a `403
   * forbidden`; render `"this command requires a platform-admin key"`
   * in CLI / UI layers.
   *
   * Quota read/write is intentionally NOT duplicated here — it lives on
   * `client.tenants.quotas.{getById, set}` and is already platform-
   * admin-gated. The admin namespace mirrors what the CLI's `my admin`
   * tree exposes; quotas are reached via the existing tenants surface.
   */
  readonly admin = {
    tenants: {
      /** List every tenant in the instance with current status. */
      list: async (): Promise<Tenant[]> => {
        const res = await this.transport.request<{ data: Tenant[] }>(
          "GET",
          "/admin/tenants",
        );
        return res.data;
      },

      /**
       * Single tenant + per-tenant quota overrides + the most-recent
       * `system.activity` items for the tenant (`null` quotas when no
       * override is configured; quota fields then resolve to instance
       * defaults).
       */
      show: async (
        tenantId: string,
      ): Promise<{
        tenant: Tenant;
        quotas: TenantQuota | null;
        recent_activity: TenantActivityEntry[];
      }> => {
        return this.transport.request<{
          tenant: Tenant;
          quotas: TenantQuota | null;
          recent_activity: TenantActivityEntry[];
        }>("GET", `/admin/tenants/${encodeURIComponent(tenantId)}`);
      },

      /**
       * Flip the tenant's status to `'suspended'`. Future non-GET
       * requests from credentials in the tenant return HTTP 403
       * `tenant_suspended`. Reads pass through; platform-admin keys
       * bypass. Idempotent.
       */
      suspend: async (tenantId: string): Promise<Tenant> => {
        return this.transport.request<Tenant>(
          "POST",
          `/admin/tenants/${encodeURIComponent(tenantId)}/suspend`,
        );
      },

      /** Reverse of `suspend`. Idempotent. */
      unsuspend: async (tenantId: string): Promise<Tenant> => {
        return this.transport.request<Tenant>(
          "POST",
          `/admin/tenants/${encodeURIComponent(tenantId)}/unsuspend`,
        );
      },

      /**
       * Per-tenant usage snapshot — item count by state, blob count
       * and total bytes, custom-type count, plus recent activity.
       */
      metrics: async (tenantId: string): Promise<TenantMetrics> => {
        return this.transport.request<TenantMetrics>(
          "GET",
          `/admin/tenants/${encodeURIComponent(tenantId)}/metrics`,
        );
      },
    },

    keys: {
      /** Active (non-revoked) keys for the named tenant. Operator
       *  surface for emergency revocation — pair with `client.keys.revoke`. */
      list: async (tenantId: string): Promise<TenantApiKeySummary[]> => {
        const res = await this.transport.request<{
          data: TenantApiKeySummary[];
        }>("GET", `/admin/tenants/${encodeURIComponent(tenantId)}/keys`);
        return res.data;
      },
    },

    accountDeletion: {
      /**
       * Force a one-shot run of the pending-delete purger (T-124).
       * Returns the number of accounts purged this tick. Useful when
       * an account has just passed its grace window and the operator
       * doesn't want to wait for the next scheduled sweep (default
       * cadence: 1 hour).
       *
       * Idempotent: re-running with no eligible rows returns 0. Only
       * sweeps accounts already past `pending_deletion_at + grace_days`
       * — does not bypass the grace window. The `run_at` timestamp is
       * server-stamped at the moment `runOnce()` begins.
       */
      purgeNow: async (): Promise<{
        purged_count: number;
        run_at: string;
      }> => {
        return this.transport.request<{
          purged_count: number;
          run_at: string;
        }>("POST", "/admin/account-deletion/purge-now");
      },
    },
  };

  // ---- Auth (T-116) ----

  /**
   * Account-lifecycle surface (T-116).
   *
   * The data plane (every other namespace on the client) authenticates
   * with a bearer token; these account-management endpoints accept
   * EITHER a bearer (tenant_admin / admin in the user's tenant)
   * OR a better-auth session cookie. The CLI flow uses a bearer (the
   * user's own key); web flows use the cookie. The transport sends
   * the bearer header by default, so SDK callers operating with a
   * bearer just work.
   */
  readonly auth = {
    account: {
      /** Initiate deletion. Mints a confirm token and dispatches the
       *  confirmation email. Returns when the request is accepted
       *  (HTTP 202). Idempotent within the token TTL. */
      requestDelete: async (): Promise<void> => {
        await this.transport.request<{ ok: true }>(
          "POST",
          "/auth/account/delete",
        );
      },
      /** Consume a confirmation token. The server's GET response is an
       *  HTML page intended for the email recipient's browser; this
       *  helper exposes the same effect to programmatic callers (CLI
       *  / integration tests). Throws on bad / expired tokens. */
      confirmDelete: async (token: string): Promise<void> => {
        const res = await this.transport.rawRequest(
          "GET",
          `/auth/account/delete/confirm?token=${encodeURIComponent(token)}`,
        );
        if (!res.ok) {
          throw new Error(
            `Account-delete confirm failed (${String(res.status)})`,
          );
        }
      },
      /** Cancel an in-flight deletion (session-cookie or bearer path).
       *  Throws if the account is not in pending-deletion. */
      cancel: async (): Promise<void> => {
        await this.transport.request<{ ok: true }>(
          "POST",
          "/auth/account/delete/cancel",
        );
      },
    },
  };

  // ---- Profile (T-074) ----

  /**
   * The calling user's profile. `system.profile` is a virtual type —
   * served by a dedicated endpoint over the `users` table joined to
   * `auth_user` for the canonical email. Username changes go through
   * the same handle validators as `PUT /auth/me/handle`.
   *
   * Apps that need a third-party-OAuth-style read should use the
   * standard OIDC `profile` / `email` scopes via `/auth/oauth2/userinfo`
   * instead — this surface is for first-party callers (CLI, MCP, the
   * user themselves) holding a tenant-scoped bearer.
   */
  readonly profile = {
    /** Read the calling user's profile. */
    get: async (): Promise<Profile> => {
      return this.transport.request<Profile>("GET", "/profile/me");
    },

    /**
     * Update the calling user's profile. Every field optional; `null`
     * clears (where applicable). `username` runs through the
     * reserved-handle / collision validators server-side.
     */
    update: async (input: UpdateProfileInput): Promise<Profile> => {
      return this.transport.request<Profile>("PATCH", "/profile/me", {
        body: input,
      });
    },

    /**
     * Upload an avatar. Accepts a Blob/File or a Uint8Array. The server
     * stores the bytes in the existing R2-backed blob layer and stamps
     * the content-addressed hash onto the user row.
     */
    setAvatar: async (
      data: Blob | Uint8Array,
      mimeType?: string,
    ): Promise<Profile> => {
      const form = new FormData();
      const blob =
        data instanceof Blob
          ? data
          : new Blob([new Uint8Array(data)], {
              type: mimeType ?? "application/octet-stream",
            });
      form.append("file", blob, "avatar");
      // Bypass the JSON path — multipart needs FormData on rawBody so
      // fetch sets Content-Type: multipart/form-data with the boundary.
      const response = await this.transport.rawRequest(
        "POST",
        "/profile/me/avatar",
        { rawBody: form },
      );
      const result = (await response.json()) as Profile | { error?: unknown };
      if (!response.ok) {
        this.throwRawError(response.status, result);
      }
      return result as Profile;
    },

    /** Clear the avatar; reverts to the deterministic placeholder. */
    clearAvatar: async (): Promise<Profile> => {
      return this.transport.request<Profile>("DELETE", "/profile/me/avatar");
    },
  };

  // ---- Internal ----

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
