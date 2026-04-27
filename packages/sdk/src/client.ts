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
  Edge,
  CreateEdgeInput,
  EdgeTypeSchema,
} from "@mymehq/shared";
import type {
  TypeSchema,
  ErrorResponse,
  Webhook,
  WebhookDelivery,
  CreateWebhookInput,
  UpdateWebhookInput,
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

export interface ClientConfig {
  url: string;
  apiKey: string;
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
}

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

  // ---- Tenants (admin) ----

  /** Tenant-scoped configuration (per-type ambient retention overrides
   * today; future tenant-level settings will live here). All endpoints
   * are admin-only. */
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
