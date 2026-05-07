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
  Edge,
  CreateEdgeInput,
  EdgeTypeSchema,
  Profile,
  UpdateProfileInput,
} from "@mymehq/shared";
import type {
  TypeSchema,
  ErrorResponse,
  Webhook,
  WebhookDelivery,
  CreateWebhookInput,
  UpdateWebhookInput,
  ConnectionInstallResult,
  ConnectionUninstallResult,
} from "@mymehq/shared";
import { HttpTransport } from "./transport.js";
import {
  MymeError,
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

// ---------------------------------------------------------------------------
// Config and option types
// ---------------------------------------------------------------------------

/** Minimal token provider shape — full interface lives in
 *  @mymehq/sdk/auth. Kept loose here so the data root doesn't depend
 *  on the auth subpath. */
interface TokenProviderLike {
  getAccessToken(): Promise<string>;
}

/**
 * Credentials are mutually exclusive at the type level: pass either a
 * static API key (myme_k1_*) or an OAuth token provider (myme_at_*).
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
   * Legacy alias for `expectedVersion`. Kept for backwards compatibility;
   * new code should use `expectedVersion`.
   * @deprecated Use `expectedVersion`.
   */
  version?: number;
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

/** Filter shape for `POST /items/bulk_action`. Mirrors the `GET /items`
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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MymeClient {
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
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const expected = options?.expectedVersion ?? options?.version;
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
     * Apply one action to every item matching a filter. Six actions
     * discriminated on `action`. Purge is admin-only and requires
     * `confirm: "PURGE"` — the SDK throws a `bulk_confirmation_required`
     * `MymeError` client-side if you forget, matching the server's 400.
     *
     * Non-admin callers see their match set narrowed to writable types
     * for every action except `purge`, which hard-403s.
     */
    bulkAction: async (input: BulkActionInput): Promise<BulkActionResult> => {
      if (input.action === "purge") {
        // Runtime guard for JS callers — the TS discriminated union
        // pins `confirm: "PURGE"` at compile time, but nothing stops a
        // plain-JS caller from omitting it. Mirrors the server's 400
        // bulk_confirmation_required so both error paths feel the same.
        const confirm = (input as { confirm?: string }).confirm;
        if (confirm !== "PURGE") {
          throw new MymeError(
            "bulk_confirmation_required",
            "bulkAction({ action: 'purge' }) requires confirm: 'PURGE'",
            400,
          );
        }
      }
      return this.transport.request<BulkActionResult>(
        "POST",
        "/items/bulk_action",
        { body: input },
      );
    },

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
        }>("POST", "/edges/types", { body: schema });
        return res.edge_type;
      },
      list: async (): Promise<EdgeTypeSchema[]> => {
        const res = await this.transport.request<{
          edge_types: EdgeTypeSchema[];
        }>("GET", "/edges/types");
        return res.edge_types;
      },
      delete: async (id: string): Promise<void> => {
        await this.transport.request<{ ok: true }>(
          "DELETE",
          `/edges/types/${id}`,
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
      return this.transport.request<TypeSchema>("POST", "/types", {
        body: schema,
      });
    },

    update: async (
      id: string,
      schema: Omit<TypeSchema, "id">,
    ): Promise<TypeSchema> => {
      return this.transport.request<TypeSchema>("PUT", `/types/${id}`, {
        body: schema,
      });
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
     * (source, default_origin, default_tier, type_permissions, and
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
  };

  // ---- Tenants (admin) ----

  /** Tenant-scoped configuration. Controls feed-tier retention per type
   * and the three optional schema-enforcement levers (TSC42 §5). All
   * endpoints are admin-only. */
  readonly tenants = {
    /** Returns the current tenant's config. Empty object when nothing
     * is configured. */
    getConfig: async (): Promise<TenantConfig> => {
      return this.transport.request<TenantConfig>(
        "GET",
        "/tenants/current/config",
      );
    },

    /** Replaces the current tenant's config. Server validates that any
     * type IDs in retention overrides resolve in the registry. */
    setConfig: async (config: TenantConfig): Promise<TenantConfig> => {
      return this.transport.request<TenantConfig>(
        "PUT",
        "/tenants/current/config",
        { body: config },
      );
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

  // ---- Profile (T-074) ----

  /**
   * The calling user's profile. `system.profile` is a virtual type —
   * served by a dedicated endpoint over the `users` table joined to
   * `auth_user` for the canonical email. Username changes go through
   * the same handle validators as `PUT /auth/me/handle`.
   *
   * Apps that need a third-party-OAuth-style read should use the
   * standard OIDC `profile` / `email` scopes via `/auth/userinfo`
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
        throw new MymeError(
          errObj?.code ?? "unknown",
          message,
          status,
          details,
        );
    }
  }
}
