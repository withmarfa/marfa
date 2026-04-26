/**
 * `MymeSyncClient` — the public entry point.
 *
 * The class is a thin shell that orchestrates four collaborators:
 *   1. PGlite — the local storage layer.
 *   2. SyncEngine — owns the read path (Electric shape subscriptions).
 *   3. MutationQueue + Drainer — own the write path.
 *   4. Mutation API namespaces (items/edges/…) — surface mutations to apps.
 *
 * In M4 we ship the shell + storage bootstrap. M5 fills in the read path,
 * M6 fills in the write path and the items API, M7 fills in edges /
 * metadata / extensions / blobs, M8 ships the React bindings on top.
 *
 * The class is designed so consumers can construct it and call methods
 * even before all phases are fleshed out — methods that aren't ready
 * throw a clear `SYNC_CLIENT_NOT_READY` error rather than silently
 * misbehaving.
 */

import { MymeClient } from "@mymehq/sdk";
import type { PGliteWithSync } from "./storage/pglite.js";
import { createPGlite } from "./storage/pglite.js";
import {
  type MymeSyncClientOptions,
  type SyncLogger,
  noopLogger,
  DEFAULT_SOURCE,
} from "./config.js";
import {
  INITIAL_SYNC_STATE,
  type SyncStateInfo,
} from "./sync/state.js";
import { SyncEngine } from "./sync/engine.js";
import { SyncEventEmitter } from "./events/emitter.js";
import type { SyncEventEnvelope, SyncEventMap, SyncEventName } from "./events/types.js";
import { MutationQueue } from "./queue/queue.js";
import { DrainLoop } from "./queue/drain.js";
import { ItemsApi } from "./api/items.js";
import { EdgesApi } from "./api/edges.js";
import { MetadataApi } from "./api/metadata.js";
import { BlobsApi } from "./api/blobs.js";

type StateListener = (info: SyncStateInfo) => void;

export class MymeSyncClient {
  private readonly options: MymeSyncClientOptions;
  private readonly logger: SyncLogger;
  private readonly emitter = new SyncEventEmitter();
  private readonly stateListeners = new Set<StateListener>();
  private pg: PGliteWithSync | null = null;
  private engine: SyncEngine | null = null;
  private queue: MutationQueue | null = null;
  private drain: DrainLoop | null = null;
  private sdk: MymeClient | null = null;
  private itemsApi: ItemsApi | null = null;
  private edgesApi: EdgesApi | null = null;
  private metadataApi: MetadataApi | null = null;
  private blobsApi: BlobsApi | null = null;
  private state: SyncStateInfo = { ...INITIAL_SYNC_STATE };
  private started = false;

  constructor(options: MymeSyncClientOptions) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Resolve the sync proxy URL. Falls back to `${apiUrl}/sync` when the
   * caller hasn't overridden.
   */
  get syncUrl(): string {
    const base = this.options.syncUrl ?? `${this.options.apiUrl}/sync`;
    return base.replace(/\/+$/, "");
  }

  /**
   * Construct the PGlite instance, apply migrations, and (in later
   * milestones) start the sync engine + drain loop. Idempotent — calling
   * twice is a no-op after the first.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.logger.info("sync-client starting", { source: this.source });

    this.pg = await createPGlite(this.options.storage ?? "memory");
    this.transition({
      ...INITIAL_SYNC_STATE,
      state: "idle",
    });

    // SDK + queue + drain wiring. The drain loop pulls from the queue
    // and pushes through the SDK; the items API populates the queue.
    // Build the SDK with an Idempotency-Key-aware fetch wrapper so
    // every queued mutation rides the M3 server middleware. The
    // closure-backed `writeIdRef` is set by the drain loop before each
    // SDK call and cleared after — drain processes one mutation at a
    // time, so there's no race.
    const writeIdRef: { value: string | null } = { value: null };
    const baseFetch =
      this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const fetchWithIdempotency: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      if (writeIdRef.value) {
        headers.set("Idempotency-Key", writeIdRef.value);
      }
      return baseFetch(input, { ...init, headers });
    };
    this.sdk = new MymeClient({
      url: this.options.apiUrl,
      apiKey: this.options.apiKey,
      fetch: fetchWithIdempotency,
    });
    this.queue = new MutationQueue(this.pg);
    this.drain = new DrainLoop({
      queue: this.queue,
      sdk: this.sdk,
      emitter: this.emitter,
      logger: this.logger,
      setCurrentWriteId: (id) => {
        writeIdRef.value = id;
      },
    });
    this.itemsApi = new ItemsApi({
      pg: this.pg,
      queue: this.queue,
      drain: this.drain,
      emitter: this.emitter,
      source: this.source,
      device: this.options.device,
      defaultOrigin: "user",
    });
    this.edgesApi = new EdgesApi({
      pg: this.pg,
      queue: this.queue,
      drain: this.drain,
      emitter: this.emitter,
    });
    this.metadataApi = new MetadataApi({
      pg: this.pg,
      queue: this.queue,
      drain: this.drain,
      emitter: this.emitter,
    });
    this.blobsApi = new BlobsApi({ sdk: this.sdk });
    if (this.options.autoStartSync !== false) {
      this.drain.start();
    }

    // Spin up the read-path sync engine. We don't await its initial
    // snapshot — apps start interacting with the local store
    // immediately, and `client.events` / `useSyncState()` surface
    // progress. Tests can pass `autoStartSync: false` to keep bootstrap
    // tests off the network.
    if (this.options.autoStartSync !== false) {
      this.engine = new SyncEngine({
        pg: this.pg,
        syncBaseUrl: this.syncUrl,
        apiKey: this.options.apiKey,
        emitter: this.emitter,
        fetch: this.options.fetch ?? globalThis.fetch.bind(globalThis),
        logger: this.logger,
        onStateChange: (info) => {
          this.transition(info);
        },
      });
      // Fire-and-forget: pglite-sync handles internal retries; failures
      // surface via the `sync.failed` event.
      void this.engine.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("sync engine start failed", { message });
        this.emitter.emit("sync.failed", {
          at: new Date(),
          error: { code: "sync_engine_start_failed", message },
        });
      });
    }

    this.started = true;
    this.emitter.emit("sync.started", { at: new Date() });
  }

  /**
   * Stop the sync engine and close the underlying PGlite. Safe to call
   * before `start()` (no-op).
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.logger.info("sync-client stopping");
    this.engine?.stop();
    this.engine = null;
    this.drain?.stop();
    this.drain = null;
    this.queue = null;
    this.itemsApi = null;
    this.edgesApi = null;
    this.metadataApi = null;
    this.blobsApi = null;
    this.sdk = null;
    if (this.pg) {
      await this.pg.close();
      this.pg = null;
    }
    this.started = false;
    this.transition({ ...INITIAL_SYNC_STATE });
  }

  /** Current sync state snapshot. */
  get syncState(): SyncStateInfo {
    return this.state;
  }

  /**
   * Subscribe to sync-state transitions. Returns an unsubscribe
   * function. Invokes the listener immediately with the current state
   * so consumers don't have a "before-first-event" gap.
   */
  observeSyncState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private transition(next: SyncStateInfo): void {
    this.state = next;
    for (const listener of this.stateListeners) {
      try {
        listener(next);
      } catch {
        // Listeners must not break the emitter.
      }
    }
  }

  /**
   * Source label stamped onto every queued mutation. Apps that span
   * multiple installs typically pass an app-specific identifier. The
   * default `'@mymehq/sync-client'` is fine for single-app deployments.
   */
  get source(): string {
    return this.options.source ?? DEFAULT_SOURCE;
  }

  /**
   * Direct read access to the local PGlite. Surfaces `query`, `live`,
   * and the Electric extension namespace. Return type is the package's
   * narrowed PGlite shape; consumers that need full PGlite power can
   * reach in further.
   */
  get db(): PGliteWithSync {
    if (!this.pg) {
      throw new Error("MymeSyncClient.start() must be awaited before .db is accessed");
    }
    return this.pg;
  }

  /**
   * Subscribe to a typed sync event. Returns an unsubscribe function.
   */
  on<K extends SyncEventName>(
    event: K,
    listener: (payload: SyncEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /** AsyncIterable of sync events. Late subscribers do not see history. */
  events(): AsyncIterableIterator<SyncEventEnvelope> {
    return this.emitter.events();
  }

  /**
   * Whether the durable mutation queue has pending writes. Consumers
   * (e.g. SyncIndicator) call this to know whether closing the app
   * would lose data. Implemented in M6.
   */
  hasPendingMutations(): Promise<boolean> {
    if (!this.pg) return Promise.resolve(false);
    return this.pg
      .query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM _myme_mutation_queue`,
      )
      .then((r) => (r.rows[0]?.n ?? 0) > 0);
  }

  /** Number of pending queue rows; used by `usePendingMutations`. */
  pendingMutationCount(): Promise<number> {
    if (!this.pg) return Promise.resolve(0);
    return this.pg
      .query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM _myme_mutation_queue`,
      )
      .then((r) => r.rows[0]?.n ?? 0);
  }

  // ── Mutation API namespaces. Real implementations land in M6 / M7. ─

  /**
   * Items mutation API. Mirrors `@mymehq/sdk` items namespace; reads
   * come from the local PGlite, writes apply optimistically and queue
   * for drain.
   */
  get items(): ItemsApi {
    if (!this.itemsApi) {
      throw new Error("MymeSyncClient.start() must be awaited before .items is accessed");
    }
    return this.itemsApi;
  }

  /** Edges mutation API. */
  get edges(): EdgesApi {
    if (!this.edgesApi) {
      throw new Error("MymeSyncClient.start() must be awaited before .edges is accessed");
    }
    return this.edgesApi;
  }

  /** Metadata + extensions API. */
  get metadata(): MetadataApi {
    if (!this.metadataApi) {
      throw new Error("MymeSyncClient.start() must be awaited before .metadata is accessed");
    }
    return this.metadataApi;
  }

  /** Blobs API — pass-through to the SDK. */
  get blobs(): BlobsApi {
    if (!this.blobsApi) {
      throw new Error("MymeSyncClient.start() must be awaited before .blobs is accessed");
    }
    return this.blobsApi;
  }
}
