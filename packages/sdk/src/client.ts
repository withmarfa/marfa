import type {
  Item,
  ItemWithMetadata,
  CreateItemInput,
  Metadata,
  Version,
  Thread,
  ApiKey,
  CreateKeyInput,
  PaginatedResult,
  SearchResult,
  ItemState,
} from "@mymehq/shared";
import type {
  TypeSchema,
  ErrorResponse,
  Webhook,
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
  timeoutMs?: number;
  cdnBaseUrl?: string;
}

export interface UpdateOptions {
  version?: number;
  thread_id?: string | null;
  /**
   * Override the client's default conflict strategy for this update.
   * - `"auto"`: auto-merge non-conflicting fields (default)
   * - `"manual"`: throw `ConflictError` with both versions
   * - `"callback"`: call the `resolve` function to handle the conflict
   */
  conflict?: ConflictStrategy;
  /** Custom conflict resolver (required when `conflict` is `"callback"`). */
  resolve?: ConflictResolver;
}

export interface ListFilters {
  type?: string;
  state?: ItemState;
  source?: string;
  parent_id?: string;
  thread_id?: string;
  root_only?: boolean;
  tags?: string[];
  filter?: string;
  sort?: "created_at" | "updated_at" | "timestamp";
  direction?: "asc" | "desc";
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchFilters {
  type?: string;
  state?: ItemState;
  filter?: string;
  limit?: number;
}

export interface MetadataInput {
  tags?: string[];
  about?: string[];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MymeClient {
  private readonly transport: HttpTransport;
  private readonly defaultConflictStrategy: ConflictStrategy;
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
    this.cdnBaseUrl = config.cdnBaseUrl;
  }

  // ---- Items ----

  readonly items = {
    create: async (input: CreateItemInput): Promise<Item> => {
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
        query: filters as Record<string, string | number | undefined>,
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
          } as unknown as Record<string, string | number | undefined>,
        },
      );
    },

    update: async (
      id: string,
      properties: Record<string, unknown>,
      options?: UpdateOptions,
    ): Promise<Item> => {
      let version = options?.version;
      if (version === undefined) {
        const item = await this.items.get(id);
        version = item.version;
      }

      const strategy = options?.conflict ?? this.defaultConflictStrategy;

      return handleConflictUpdate(
        this.transport,
        id,
        properties,
        version,
        strategy,
        options?.resolve,
        options?.thread_id,
      );
    },

    delete: async (id: string): Promise<void> => {
      await this.transport.request<undefined>("DELETE", `/items/${id}`);
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

  // ---- Threads ----

  readonly threads = {
    create: async (): Promise<Thread> => {
      const res = await this.transport.request<{ thread: Thread }>(
        "POST",
        "/threads",
      );
      return res.thread;
    },

    list: async (filters?: {
      limit?: number;
      cursor?: string;
    }): Promise<PaginatedResult<Thread>> => {
      return this.transport.request<PaginatedResult<Thread>>(
        "GET",
        "/threads",
        { query: filters as Record<string, string | number | undefined> },
      );
    },

    get: async (id: string): Promise<{ thread: Thread; items: Item[] }> => {
      return this.transport.request<{ thread: Thread; items: Item[] }>(
        "GET",
        `/threads/${id}`,
      );
    },

    addItem: async (threadId: string, itemId: string): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "POST",
        `/threads/${threadId}/items`,
        { body: { item_id: itemId } },
      );
      return res.item;
    },

    removeItem: async (threadId: string, itemId: string): Promise<Item> => {
      const res = await this.transport.request<{ item: Item }>(
        "DELETE",
        `/threads/${threadId}/items/${itemId}`,
      );
      return res.item;
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
    create: async (
      input: CreateKeyInput,
    ): Promise<{ id: string; key: string }> => {
      const res = await this.transport.request<{
        id: string;
        key: string;
        label: string;
        role: string;
        type_permissions: Record<string, string>;
        created_at: string;
      }>("POST", "/keys", { body: input });
      return { id: res.id, key: res.key };
    },

    list: async (): Promise<ApiKey[]> => {
      const res = await this.transport.request<{ keys: ApiKey[] }>(
        "GET",
        "/keys",
      );
      return res.keys;
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
