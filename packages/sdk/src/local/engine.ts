import type { MarfaClient } from "../client.js";
import { createOutboxDrain, type OutboxDrain } from "./drain.js";
import { createLocalSync, type LocalSync } from "./sync.js";
import type { LocalStore } from "./store/index.js";
import type {
  LocalEngineEvent,
  LocalEngineEventListener,
  StoreIdentity,
} from "./types.js";

/** Whether the engine is reaching the server, and how it knows. */
export type ConnectionState =
  /** Nothing has been started yet. */
  | "idle"
  /** A connection is being opened, or reopened after one dropped. */
  | "connecting"
  /** A connection is open and carrying frames. */
  | "online"
  /** The last attempt did not reach the server. */
  | "offline"
  /** Stopped deliberately. */
  | "stopped";

/**
 * What the engine will tell an app about itself.
 *
 * A snapshot rather than a live object: every field is read at the moment
 * it is asked for, so nothing here can describe a state the store has
 * already left.
 */
export interface LocalEngineStatus {
  connection: ConnectionState;
  /** Which server, space and account this store belongs to. */
  identity: StoreIdentity;
  /** False when another engine holds the store and this handle can only
   *  read. An app showing a sync status has to say so: nothing this
   *  process writes will ever be sent. */
  writer: boolean;
  /** Mutations waiting to be sent. */
  pending: number;
  /** Mutations parked, by reason. Split rather than totalled because what
   *  clears them differs: a suspended space passes on its own, a write
   *  awaiting review does not. */
  blocked: Record<string, number>;
  /** Writes the server refused, kept for the app to show. */
  deadLetters: number;
  /** When the queue last emptied cleanly, or null if it never has. */
  lastDrainedAt: string | null;
  /** Where the stream has reached, or null before it has said. */
  cursor: string | null;
  hydration: {
    /** Whether the first full read has completed. */
    done: boolean;
    /** Rows taken so far on the read in progress. Monotonic. */
    items: number;
    edges: number;
    /** What the server said it held, or undefined when it would not say. */
    totalItems: number | undefined;
  };
}

export interface LocalEngineOptions {
  store: LocalStore;
  client: MarfaClient;
  /** Transient attempts a mutation gets before it parks. */
  retryCeiling?: number;
  /** First reconnect backoff in ms. */
  initialRetryMs?: number;
  now?: () => string;
}

export interface LocalEngine {
  /** Subscribe, read, and start following the stream. */
  start(): Promise<void>;
  /** Stop following. The store keeps everything it holds. */
  stop(): void;
  /** Send what can be sent, once. */
  drain(): Promise<void>;
  /** Everything an app renders, read fresh. */
  status(): Promise<LocalEngineStatus>;
  /**
   * Events that cannot wait for the next `status` call, because each one
   * is work that has stopped moving or a change a person will notice.
   * Returns the function that stops listening.
   */
  on(listener: LocalEngineEventListener): () => void;
  readonly store: LocalStore;
}

/**
 * The engine, as one object an app can hold.
 *
 * It exists so that reporting has somewhere to live. The store, the queue
 * and the stream each know part of what a person needs to see — how much
 * is waiting, why something stopped, whether anything is getting through —
 * and an app assembling that itself would have to reach into all three and
 * would still have nowhere to put connection state, which none of them
 * keeps.
 */
export function createLocalEngine(options: LocalEngineOptions): LocalEngine {
  const { store, client } = options;
  const listeners = new Set<LocalEngineEventListener>();

  let connection: ConnectionState = "idle";
  let hydrationItems = 0;
  let hydrationEdges = 0;
  let totalItems: number | undefined;

  const emit = (event: LocalEngineEvent): void => {
    // Connection state is derived from what the engine reports rather than
    // tracked beside it, so the two cannot disagree — there is only one
    // record of what happened and this reads it.
    if (event.type === "hydration.progress") {
      hydrationItems = event.items;
      hydrationEdges = event.edges;
      totalItems = event.totalItems;
    }
    if (event.type === "drain.finished" || event.type === "catchup.finished") {
      connection = "online";
    }
    for (const listener of listeners) listener(event);
  };

  const drain: OutboxDrain = createOutboxDrain({
    store,
    client,
    ...(options.retryCeiling === undefined
      ? {}
      : { retryCeiling: options.retryCeiling }),
    onEvent: emit,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const sync: LocalSync = createLocalSync({
    store,
    client,
    drain,
    onEvent: emit,
    ...(options.initialRetryMs === undefined
      ? {}
      : { initialRetryMs: options.initialRetryMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    store,

    start: async () => {
      connection = "connecting";
      try {
        await sync.start();
        connection = "online";
      } catch (error) {
        connection = "offline";
        throw error;
      }
    },

    stop: () => {
      sync.stop();
      connection = "stopped";
    },

    drain: async () => {
      const result = await drain.drain();
      // The drain is the one thing here that reports reachability
      // directly, because it is the only part that gets an answer rather
      // than a stream that may simply be quiet.
      if (result.offline) connection = "offline";
      else if (connection !== "stopped") connection = "online";
    },

    status: async () => {
      const queued = await store.outbox.list();
      const blocked: Record<string, number> = {};
      let pending = 0;
      for (const entry of queued) {
        if (entry.state === "pending") {
          pending += 1;
          continue;
        }
        const reason = entry.blockedReason ?? "unknown";
        blocked[reason] = (blocked[reason] ?? 0) + 1;
      }
      const state = await store.syncState.read(store.identity);
      return {
        connection,
        identity: store.identity,
        writer: store.writer,
        pending,
        blocked,
        deadLetters: (await store.deadLetters.list()).length,
        lastDrainedAt: state?.lastDrainedAt ?? null,
        cursor: state?.cursor ?? null,
        hydration: {
          done: state?.hydratedAt != null,
          items: hydrationItems,
          edges: hydrationEdges,
          totalItems,
        },
      };
    },

    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
