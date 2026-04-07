import type {
  Item,
  CreateItemInput,
  Metadata,
  Version,
  Thread,
  ApiKey,
  CreateKeyInput,
  PaginatedResult,
  SearchResult,
} from "@mymehq/shared";
import type { TypeSchema } from "@mymehq/shared";
import {
  MymeClient,
  type ClientConfig,
  type UpdateOptions,
  type ListFilters,
  type SearchFilters,
  type MetadataInput,
} from "@mymehq/sdk";
import { createLocalStorage } from "./local/storage.js";
import type { LocalStorage } from "./local/storage.js";
import { createShapeStreams } from "./electric/collections.js";
import { ElectricBridge } from "./electric/bridge.js";
import { ConnectionStateManager } from "./electric/connection-state.js";
import type {
  ConnectionState,
  ConnectionStateListener,
} from "./electric/connection-state.js";
import { MutationQueue } from "./electric/mutation-queue.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SyncClientConfig extends ClientConfig {
  electric: {
    url: string;
  };
  local: {
    path: string;
  };
}

// ---------------------------------------------------------------------------
// MymeSyncClient
// ---------------------------------------------------------------------------

/**
 * Extended client that reads from local SQLite (via Electric sync) and writes
 * via HTTP. Falls back to HTTP-only when Electric is unavailable.
 */
export class MymeSyncClient {
  private readonly httpClient: MymeClient;
  private readonly localStorage: LocalStorage;
  private readonly connectionManager: ConnectionStateManager;
  private readonly mutationQueue: MutationQueue;
  private bridge: ElectricBridge | null = null;
  private readonly electricConfig: { url: string };

  constructor(config: SyncClientConfig) {
    this.httpClient = new MymeClient(config);
    this.localStorage = createLocalStorage(config.local.path);
    this.connectionManager = new ConnectionStateManager();
    this.mutationQueue = new MutationQueue(
      this.localStorage.db,
      this.httpClient,
    );
    this.electricConfig = config.electric;

    // Auto-flush queue when connected
    this.connectionManager.subscribe((state) => {
      if (state === "connected") {
        void this.mutationQueue.flush();
      }
    });
  }

  // ---- Lifecycle ----

  start(): void {
    const streams = createShapeStreams(this.electricConfig);
    this.bridge = new ElectricBridge(
      streams,
      this.localStorage,
      this.connectionManager,
    );
    this.bridge.start();
  }

  stop(): void {
    this.bridge?.stop();
    this.bridge = null;
  }

  close(): void {
    this.stop();
    this.localStorage.close();
  }

  // ---- Connection state ----

  get connectionState(): ConnectionState {
    return this.connectionManager.current;
  }

  onConnectionStateChange(listener: ConnectionStateListener): () => void {
    return this.connectionManager.subscribe(listener);
  }

  // ---- Items (local reads, HTTP writes) ----

  readonly items = {
    create: async (input: CreateItemInput): Promise<Item> => {
      // Write through HTTP
      const item = await this.httpClient.items.create(input);
      // Optimistically write to local
      this.localStorage.items.upsert(item);
      return item;
    },

    get: (id: string): Item | null => {
      // Read from local
      return this.localStorage.items.get(id);
    },

    list: (filters?: ListFilters): PaginatedResult<Item> => {
      // Read from local
      return this.localStorage.items.list(filters);
    },

    update: async (
      id: string,
      properties: Record<string, unknown>,
      options?: UpdateOptions,
    ): Promise<Item> => {
      const item = await this.httpClient.items.update(id, properties, options);
      this.localStorage.items.upsert(item);
      return item;
    },

    delete: async (id: string): Promise<void> => {
      await this.httpClient.items.delete(id);
      this.localStorage.items.remove(id);
    },

    restore: async (id: string): Promise<Item> => {
      const item = await this.httpClient.items.restore(id);
      this.localStorage.items.upsert(item);
      return item;
    },

    transition: async (id: string, state: string): Promise<Item> => {
      const item = await this.httpClient.items.transition(id, state);
      this.localStorage.items.upsert(item);
      return item;
    },

    versions: async (id: string): Promise<Version[]> => {
      // Always HTTP — version history is server-side
      return this.httpClient.items.versions(id);
    },
  };

  // ---- Metadata (local reads, HTTP writes) ----

  readonly metadata = {
    get: (itemId: string): Metadata | null => {
      return this.localStorage.metadata.get(itemId);
    },

    set: async (itemId: string, input: MetadataInput): Promise<Metadata> => {
      const meta = await this.httpClient.metadata.set(itemId, input);
      this.localStorage.metadata.upsert(meta);
      return meta;
    },

    addTags: async (itemId: string, tags: string[]): Promise<Metadata> => {
      const meta = await this.httpClient.metadata.addTags(itemId, tags);
      this.localStorage.metadata.upsert(meta);
      return meta;
    },

    removeTag: async (itemId: string, tag: string): Promise<void> => {
      await this.httpClient.metadata.removeTag(itemId, tag);
    },
  };

  // ---- Search (always HTTP) ----

  async search(
    query: string,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    return this.httpClient.search(query, filters);
  }

  // ---- Threads (local reads, HTTP writes) ----

  readonly threads = {
    create: async (): Promise<Thread> => {
      const thread = await this.httpClient.threads.create();
      this.localStorage.threads.upsert(thread);
      return thread;
    },

    list: (filters?: {
      limit?: number;
      cursor?: string;
    }): PaginatedResult<Thread> => {
      return this.localStorage.threads.list(filters?.limit);
    },

    get: async (id: string): Promise<{ thread: Thread; items: Item[] }> => {
      // Thread from local, items from HTTP (need full server query)
      return this.httpClient.threads.get(id);
    },
  };

  // ---- Blobs (always HTTP) ----

  readonly blobs = {
    upload: async (
      data: Buffer | Uint8Array,
      mimeType: string,
    ): Promise<{ hash: string }> => {
      return this.httpClient.blobs.upload(data, mimeType);
    },

    download: async (hash: string): Promise<ArrayBuffer> => {
      return this.httpClient.blobs.download(hash);
    },
  };

  // ---- Types (always HTTP) ----

  readonly types = {
    list: async (): Promise<TypeSchema[]> => {
      return this.httpClient.types.list();
    },

    get: async (id: string): Promise<TypeSchema> => {
      return this.httpClient.types.get(id);
    },
  };

  // ---- Keys (always HTTP) ----

  readonly keys = {
    create: async (
      input: CreateKeyInput,
    ): Promise<{ id: string; key: string }> => {
      return this.httpClient.keys.create(input);
    },

    list: async (): Promise<ApiKey[]> => {
      return this.httpClient.keys.list();
    },

    revoke: async (id: string): Promise<void> => {
      return this.httpClient.keys.revoke(id);
    },
  };
}
